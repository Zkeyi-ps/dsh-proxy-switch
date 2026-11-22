/**
 * dsh-proxy-switch
 *
 * 运行时探测本地代理端口，把 DSH 的出站 HTTP 策略在「代理」和「直连」之间切换，
 * 不需要重启宿主。插件被禁用时整体 dispose，还原到加载前的状态。
 *
 * 依据：@deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment() 返回 disposer，
 * 且传入空代理环境时会安装 DIRECT 策略 —— 两个方向都能显式表达。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-proxy-switch'

const DEFAULTS = {
  proxyHost: '127.0.0.1',
  proxyPort: 0,                                    // >0 时只探这个端口；0 = 自动
  proxyPorts: [7897, 7890, 10809, 8080],           // 自动模式的候选端口，按顺序
  probeIntervalSec: 30,
  probeTimeoutMs: 400,
  discoverProcesses: true,                         // 配置端口都不通时，从代理进程的监听端口里找
  discoverTimeoutMs: 4000,
  discoverCacheSec: 60,                            // 进程发现的缓存时间，避免每轮都拉起 netstat
}

const TAG = '[dsh-proxy-switch]'
const log = (m) => console.log(TAG + ' ' + m)
const warn = (m) => console.warn(TAG + ' ' + m)

/** 用户可编辑的配置文件，放在 $DSH_HOME 下，比改 node_modules 里的 YAML 好找。 */
function configFilePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'proxy-switch.json')
}

/**
 * 每次复查都重读配置文件，所以改完不需要重启宿主。
 * 文件不存在、不是合法 JSON、或不是对象时一律忽略，沿用 cordis 配置。
 */
function readFileConfig() {
  const p = configFilePath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (e) {
    warn('配置文件解析失败，忽略：' + p + ' — ' + (e && e.message ? e.message : e))
    return {}
  }
}

/** TCP 探测：只判断端口是否接受连接，不发数据。 */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 用一次真实的 HTTP CONNECT 确认这个端口是 HTTP 代理，而不是恰好也开着端口的
 * 本地服务（比如 clash-verge 自己的 API 端口 33331）。只发给一个固定目标，
 * 不携带任何请求内容。
 */
function probeHttpProxy(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
    })
    let acc = ''
    socket.on('data', (d) => {
      acc += d.toString('latin1')
      if (acc.indexOf('\r\n') !== -1) done(/^HTTP\/1\.[01] 2\d\d/.test(acc))
    })
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 已知代理客户端进程名。命中后读它们监听的端口，自定义端口也能发现。 */
const PROXY_PROCESS_RE = /clash|mihomo|verge|v2ray|xray|sing-?box|shadowsocks|hysteria|trojan|nekoray|nekobox|karing/i

function runFile(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
}

/**
 * 从本机监听端口里找出代理客户端占用的那些。
 *
 * Windows 用 netstat -ano + tasklist 两份输出对齐 PID。其它平台返回空数组，
 * 由配置的候选端口兜底。
 */
async function discoverProxyPorts(timeoutMs) {
  if (process.platform !== 'win32') return []
  const [netstat, tasklist] = await Promise.all([
    runFile('netstat', ['-ano'], timeoutMs),
    runFile('tasklist', ['/FO', 'CSV', '/NH'], timeoutMs),
  ])
  if (!netstat || !tasklist) return []

  const proxyPids = new Set()
  for (const line of tasklist.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/)
    if (m && PROXY_PROCESS_RE.test(m[1])) proxyPids.add(m[2])
  }
  if (proxyPids.size === 0) return []

  const ports = new Set()
  for (const line of netstat.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    if (!/LISTENING/i.test(cols[3])) continue
    const pid = cols[4]
    if (!proxyPids.has(pid)) continue
    const port = Number(cols[1].split(':').pop())
    if (port > 0 && port < 65536) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/** 进程发现结果的缓存：netstat + tasklist 两次进程拉起，不能每轮都做。 */
let discoveryCache = { at: 0, ports: [] }

async function cachedDiscoveredPorts(cfg) {
  const ttl = Math.max(10, Number(cfg.discoverCacheSec) || 60) * 1000
  const now = Date.now()
  if (now - discoveryCache.at < ttl) return discoveryCache.ports
  const ports = await discoverProxyPorts(Math.max(1000, Number(cfg.discoverTimeoutMs) || 4000))
  discoveryCache = { at: now, ports }
  if (ports.length > 0) log('从代理进程发现监听端口：' + ports.join(', '))
  return ports
}

/**
 * 返回第一个可用的代理端口。
 *
 * 顺序：显式 proxyPort → 配置的 proxyPorts → 代理进程的监听端口。
 * 前两者只做 TCP 探测（快）；最后一批必须用 CONNECT 验证，否则会把
 * 客户端自己的 API 端口（例如 clash-verge 的 33331）误当成代理。
 */
async function findLivePort(cfg) {
  const explicit = Number(cfg.proxyPort) || 0
  if (explicit > 0) {
    return (await probe(cfg.proxyHost, explicit, cfg.probeTimeoutMs)) ? explicit : 0
  }

  const seen = new Set()
  const list = Array.isArray(cfg.proxyPorts) ? cfg.proxyPorts : DEFAULTS.proxyPorts
  for (const raw of list) {
    const port = Number(raw) || 0
    if (port <= 0 || seen.has(port)) continue
    seen.add(port)
    if (await probe(cfg.proxyHost, port, cfg.probeTimeoutMs)) return port
  }

  if (cfg.discoverProcesses === false) return 0
  const discovered = await cachedDiscoveredPorts(cfg)
  for (const port of discovered) {
    if (seen.has(port)) continue
    seen.add(port)
    if (await probeHttpProxy(cfg.proxyHost, port, Math.max(600, cfg.probeTimeoutMs * 3))) return port
  }
  return 0
}

/**
 * app 的 node_modules 候选路径。
 *
 * 生产环境走 execPath 推导（宿主进程的 execPath 是 DeepSeek Harness.exe）。
 * DSH_APP_NODE_MODULES 是显式逃生门：安装位置特殊、或以 ELECTRON_RUN_AS_NODE
 * 子进程形态运行时，可以手动指定。
 */
function appNodeModulesCandidates() {
  const out = []
  const override = process.env.DSH_APP_NODE_MODULES
  if (override && override.trim()) out.push(override.trim())
  if (process.execPath) {
    const exeDir = path.dirname(process.execPath)
    out.push(path.join(exeDir, 'resources', 'app', 'dsh', 'node_modules'))
    out.push(path.join(exeDir, 'resources', 'app', 'node_modules'))
  }
  return out
}

function locateAppModule(relPath) {
  for (const base of appNodeModulesCandidates()) {
    const p = path.join(base, relPath)
    if (existsSync(p)) return p
  }
  return null
}

async function loadAppModule(pkgName, relPath) {
  try {
    return await import(pkgName)
  } catch {
    // 包名解析不到（profile 的 node_modules 里没有），走可执行文件推导路径
  }
  const p = locateAppModule(relPath)
  if (!p) throw new Error('无法定位 ' + pkgName + '（推导路径：' + appNodeModulesCandidates().join(' | ') + '）')
  return await import(pathToFileURL(p).href)
}

/**
 * 配置 schema。
 *
 * 宿主的 settings 文档只服务「声明了 Config 的插件」——没有它，插件页会显示
 * 「该插件当前未加载，暂时无法配置」。所以这里必须导出 Config，即使配置页只是
 * 一个可选项。
 *
 * schemastery 不在 profile 的 node_modules 里，只能从宿主可执行文件推导加载；
 * 加载失败时导出 undefined（插件本体照常工作，只是没有配置页），不让它拖垮启动。
 */
let Config
try {
  const schemastery = await loadAppModule('@deepseek-ai/schemastery', '@deepseek-ai/schemastery/lib/index.mjs')
  const z = schemastery.default ?? schemastery
  Config = z.object({
    proxyHost: z.string().default('127.0.0.1'),
    proxyPort: z.number().step(1).min(0).default(0),
    proxyPorts: z.array(z.number()).default([7897, 7890, 10809, 8080]),
    probeIntervalSec: z.number().step(1).min(5).default(30),
    probeTimeoutMs: z.number().step(1).min(100).default(400),
    discoverProcesses: z.boolean().default(true),
    discoverTimeoutMs: z.number().step(1).min(1000).default(4000),
    discoverCacheSec: z.number().step(1).min(10).default(60),
  })
} catch (e) {
  warn('无法加载 schemastery，配置页不可用：' + (e && e.message ? e.message : e))
}
export { Config }

export function apply(ctx, config) {
  const base = { ...DEFAULTS, ...(config || {}) }
  log('已加载；配置文件 ' + configFilePath())

  ctx.effect(() => {
    let stopped = false
    let timer = null
    let lastKey = null
    let installed = null
    let proxyLib = null
    let envLib = null

    async function ensureLibs() {
      if (!proxyLib) {
        proxyLib = await loadAppModule('@deepseek-ai/dsh-http-proxy', '@deepseek-ai/dsh-http-proxy/lib/index.js')
      }
      if (!envLib) {
        envLib = await loadAppModule('@deepseek-ai/dsh-launch-environment', '@deepseek-ai/dsh-launch-environment/lib/index.js')
      }
    }

    /** 显式安装一份策略：url 为 null 时安装直连。 */
    async function install(url) {
      await ensureLibs()
      if (installed) {
        const d = installed
        installed = null
        try { await d() } catch (e) { warn('旧策略卸载失败：' + (e && e.message ? e.message : e)) }
      }
      const values = url ? { HTTP_PROXY: url, HTTPS_PROXY: url } : {}
      const env = envLib.createLaunchEnvironmentSnapshot([{ source: 'process', values }])
      installed = await proxyLib.installProxyFromEnvironment(env, (m) => warn('代理值被跳过：' + m))
    }

    async function reconcile() {
      if (stopped) return
      const cfg = { ...base, ...readFileConfig() }
      const port = await findLivePort(cfg)
      if (stopped) return

      const key = port > 0 ? 'proxy:' + port : 'direct'
      if (key === lastKey) return
      const previous = lastKey
      lastKey = key

      try {
        if (port > 0) {
          const url = 'http://' + cfg.proxyHost + ':' + port
          await install(url)
          if (stopped) return
          log('代理在线（端口 ' + port + '）→ 已切到 ' + url)
        } else {
          await install(null)
          if (stopped) return
          log(previous === null ? '未发现可用代理 → 保持直连' : '代理离线 → 已切回直连')
        }
      } catch (e) {
        warn('切换失败：' + (e && e.message ? e.message : e))
        lastKey = previous
      }
    }

    reconcile()
    timer = setInterval(reconcile, Math.max(5, Number(base.probeIntervalSec) || 30) * 1000)
    if (timer.unref) timer.unref()

    return () => {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
      if (installed) {
        const d = installed
        installed = null
        Promise.resolve().then(() => d()).catch(() => {})
      }
      log('插件已卸载，恢复加载前的状态')
    }
  }, 'dsh-proxy-switch')
}