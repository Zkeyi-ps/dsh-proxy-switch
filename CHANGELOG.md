# Changelog

## 0.2.0 — 2026-11-22

- **插件页配置页**：点开 `dsh-proxy-switch` 卡片，代理端口与复查间隔可直接在界面里修改并保存（写回 profile 的 `cordis.patch.yml`）
- **自定义端口自动发现**：常见端口都不通时，读取本机代理客户端（Clash / mihomo / v2ray / xray / sing-box / shadowsocks / hysteria / nekoray / karing）实际监听的端口，并用真实 `CONNECT` 请求验证确实是 HTTP 代理，避免误用客户端自己的 API 端口
- `$DSH_HOME/proxy-switch.json` 配置文件每次复查重读，改完不用重启
- 新增 `disable-proxy-switch-ui.cmd` 式的降级路径：去掉 `dsh.client` 声明即可只停界面、保留宿主插件

## 0.1.0 — 2026-11-22

首个版本。

- 零配置：按顺序自动探测 `7897 / 7890 / 10809 / 8080`
- 运行时挂载/卸载 DSH 出站代理策略，梯子开关变化自动跟随
- 端口离线时显式安装直连策略，而不是仅依赖 dispose
- 插件禁用时 dispose，还原到加载前状态
- 模块定位从 `process.execPath` 推导，支持 `DSH_APP_NODE_MODULES` 覆盖