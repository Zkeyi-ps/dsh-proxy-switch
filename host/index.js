/**
 * dsh-proxy-switch
 *
 * 运行时探测本地代理端口，把 DSH 的出站 HTTP 策略在「代理」和「直连」之间切换，
 * 不需要重启宿主。插件被禁用时整体 dispose，还原到加载前的状态。
 *
 * 依据：@deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment() 返回 disposer，
 * 且传入空代理环境时会安装 DIRECT 策略 —— 两个方向都能显式表达。
 */
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

/** 返回第一个活着的端口；显式指定了 proxyPort 时只探那一个。 */
async function findLivePort(cfg) {
  const explicit = Number(cfg.proxyPort) || 0
  if (explicit > 0) {
    return (await probe(cfg.proxyHost, explicit, cfg.probeTimeoutMs)) ? explicit : 0
  }
  const list = Array.isArray(cfg.proxyPorts) ? cfg.proxyPorts : DEFAULTS.proxyPorts
  for (const raw of list) {
    const port = Number(raw) || 0
    if (port <= 0) continue
    if (await probe(cfg.proxyHost, port, cfg.probeTimeoutMs)) return port
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