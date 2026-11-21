# dsh-proxy-switch

给 [DeepSeek Harness](https://www.deepseek.com/harness/) 用的代理开关插件：**运行时探测本地代理端口，自动挂载或卸载宿主的出站 HTTP 代理策略，不需要重启。**

[English](README.en.md) | 中文

---

## 它解决什么问题

DSH 的出站代理策略由 `@deepseek-ai/dsh-http-proxy` 在**进程启动时**从环境变量解析一次，之后固定不变。

于是有一个很实际的麻烦：

- 开着梯子启动 DSH → 能用外网；中途关掉梯子 → 所有请求卡在死代理上
- 没开梯子启动 DSH → 外网全挂；中途开梯子 → 仍然用不了，除非重启

这个插件把那次「一次性的解析」变成**持续维持的状态**。

## 行为

```
插件加载
  │
  ├─ 探测 127.0.0.1:7897
  │    ├─ 在线 → 安装代理策略（出站走代理）
  │    └─ 离线 → 显式安装直连策略
  │
  ├─ 每 30 秒复查一次
  │    ├─ 关 → 开  自动切到代理
  │    └─ 开 → 关  自动切回直连
  │
  └─ 插件被禁用 → dispose，还原到加载前的状态
```

**显式安装直连策略**这一点很重要：如果只做 `dispose()`，那么当宿主启动时就带着一个已经失效的代理时，dispose 会把那个死代理还原回来。插件对两个方向都显式安装。

## 安装

```bash
dsh plugin add github:Zkeyi-ps/dsh-proxy-switch
```

或手动：把本仓库放到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-proxy-switch`，并把包名加进该 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies`。

安装后重启宿主。插件页「已安装」里会出现 `dsh-proxy-switch`，卡片上的行开关就是启停。

## 配置

**默认零配置。** 插件按顺序探测常见代理端口，第一个响应的就用：

```
7897   Clash Verge（mixed 端口，最常见）
7890   Clash / Clash for Windows（HTTP）
10809  v2rayN（HTTP）
8080   通用 HTTP 代理
```

**自定义端口也不用配。** 上面这些都不通时，插件会读本机代理客户端实际监听的端口（Clash / mihomo / Clash Verge / v2ray / xray / sing-box / shadowsocks / hysteria / nekoray / karing…），并对每个候选发一次真实的 `CONNECT` 请求确认它确实是 HTTP 代理——这样客户端自己的 API 端口（例如 clash-verge 的 33331）不会被误用。

不在列表里的代理，用下面任一方式指定。

### 方式一：`$DSH_HOME/proxy-switch.json`（推荐）

```
Windows:  C:\Users\<你>\.dsh\proxy-switch.json
macOS:    ~/.dsh/proxy-switch.json
```

```json
{
  "proxyHost": "127.0.0.1",
  "proxyPort": 8888
}
```

**改完不用重启。** 插件每次复查（默认 30 秒）都会重读这个文件，端口变了会重新挂载。删掉文件就回到自动探测。

也可以只改探测列表，保留自动行为：

```json
{
  "proxyPorts": [8888, 7897, 1080]
}
```

### 方式二：`cordis.patch.yml`

```yaml
- insert:
    - id: dsh-proxy-switch
      name: 'dsh-proxy-switch'
      config:
        proxyHost: 127.0.0.1
        proxyPort: 0             # 0 = 自动探测 proxyPorts
        proxyPorts: [7897, 7890, 10809, 8080]
        probeIntervalSec: 30     # 复查间隔，最小 5 秒
        probeTimeoutMs: 400      # 单次 TCP 探测超时
```

`proxyPort` 大于 0 时只探那一个端口；为 0 时按 `proxyPorts` 顺序自动探测。

`proxy-switch.json` 里的同名字段会覆盖这里的值。

改动在 profile 启用 HMR 时即时重组；否则重启宿主生效。

### 为什么不读系统代理设置

DSH 的 `dsh-http-proxy` 只接受环境变量里的 `http(s)://` 代理 URL，不读 Windows/macOS 的系统代理，也不支持 SOCKS 或 PAC。本插件沿用同一份策略，因此同样只支持 HTTP 代理。
## 原理

`@deepseek-ai/dsh-http-proxy` 导出 `installProxyFromEnvironment(env, report)`，返回一个 **disposer**。插件用它在运行时装卸策略：

- `env` 必须是 `createLaunchEnvironmentSnapshot()` 造出的快照（`Map<name, {value}>`），不是普通对象
- 传空代理环境会安装 **DIRECT** 策略，这就是「显式直连」
- disposer 会同时还原 dispatcher、策略和 `process.env`

模块从宿主可执行文件推导定位：

```
dirname(process.execPath) / resources / app / dsh / node_modules
```

可用环境变量 `DSH_APP_NODE_MODULES` 覆盖（安装位置特殊、或宿主以 `ELECTRON_RUN_AS_NODE` 子进程形态运行时）。

## 兼容性

| 插件版本 | 适配 DSH |
| --- | --- |
| 0.1.0 | 0.2.0-rc.2（开发验证） |

依赖的是 DSH 内部包 `@deepseek-ai/dsh-http-proxy` 的公开导出。DSH 升级后若该导出签名变化，插件需要跟进。

## 已知限制

- **无配置界面**。配置写在 `cordis.patch.yml`，重启或 HMR 生效。配置页（`plugins.bundle.config`）计划在后续版本。
- **只支持 HTTP 代理**。SOCKS / PAC 不支持，这是上游策略的限制。
- **不管理代理软件本身**。插件只探测端口，不启动 Clash / v2ray 之类。
- **loopback 始终直连**。这是上游行为：`localhost`、`127.0.0.0/8`、`::1` 不会被代理，所以 DSH 与本地模型网关的通信不受影响。

## 开发

插件是纯 host 侧 cordis 插件，无构建步骤：

```
host/index.js       插件主体（ESM，导出 name 与 apply）
cordis.patch.yml    组合包 patch，把插件插进 profile 树
dsh.plugin.json     插件清单（描述、贡献点）
```

本地验证：把包目录放进某个 profile 的 `node_modules`，在 `dsh.profile.bundles` 里登记包名，重启宿主。

## License

MIT