/**
 * dsh-proxy-switch
 *
 * 运行时探测本地代理端口，把 DSH 的出站 HTTP 策略在「代理」和「直连」之间切换，
 * 不需要重启宿主。插件被禁用时整体 dispose，还原到加载前的状态。
 *
 * 依据：@deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment() 返回 disposer，
 * 且传入空代理环境时会安装 DIRECT 策略 —— 两个方向都能显式表达。
 */
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-proxy-switch'

const DEFAULTS = {
  proxyHost: '127.0.0.1',
  proxyPort: 7897,
  probeIntervalSec: 30,
  probeTimeoutMs: 400,
}

const TAG = '[dsh-proxy-switch]'
const log = (m) => console.log(TAG + ' ' + m)
const warn = (m) => console.warn(TAG + ' ' + m)

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
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const url = 'http://' + cfg.proxyHost + ':' + cfg.proxyPort
  log('已加载；探测 ' + cfg.proxyHost + ':' + cfg.proxyPort + '，间隔 ' + cfg.probeIntervalSec + 's')

  ctx.effect(() => {
    let stopped = false
    let timer = null
    let lastState = null
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

    /** 显式安装一份策略：up=true 走代理，up=false 走直连。 */
    async function install(up) {
      await ensureLibs()
      if (installed) {
        const d = installed
        installed = null
        try { await d() } catch (e) { warn('旧策略卸载失败：' + (e && e.message ? e.message : e)) }
      }
      const values = up ? { HTTP_PROXY: url, HTTPS_PROXY: url } : {}
      const env = envLib.createLaunchEnvironmentSnapshot([{ source: 'process', values }])
      installed = await proxyLib.installProxyFromEnvironment(env, (m) => warn('代理值被跳过：' + m))
    }

    async function reconcile() {
      if (stopped) return
      const up = await probe(cfg.proxyHost, cfg.proxyPort, cfg.probeTimeoutMs)
      if (stopped) return
      if (up === lastState) return
      const previous = lastState
      lastState = up
      try {
        await install(up)
        if (stopped) return
        log(up
          ? '代理在线 → 已切到 ' + url
          : (previous === null ? '代理不在线 → 保持直连' : '代理离线 → 已切回直连'))
      } catch (e) {
        warn('切换失败：' + (e && e.message ? e.message : e))
        lastState = previous
      }
    }

    reconcile()
    timer = setInterval(reconcile, Math.max(5, cfg.probeIntervalSec) * 1000)
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