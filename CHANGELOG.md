# Changelog

## 0.1.0 — 2026-11-22

首个版本。

- **零配置**：按顺序自动探测常见代理端口 `7897 / 7890 / 10809 / 8080`，第一个响应的就用
- 运行时挂载/卸载 DSH 的出站代理策略，梯子开关变化自动跟随，无需重启宿主
- 端口离线时**显式**安装直连策略，而不是仅依赖 dispose（宿主带着死代理启动时，dispose 会把死代理还原回来）
- **`$DSH_HOME/proxy-switch.json` 配置文件**，每次复查重读，改完不用重启；删掉即回到自动探测
- 插件禁用时 dispose，还原到加载前状态
- 模块定位从 `process.execPath` 推导，支持 `DSH_APP_NODE_MODULES` 覆盖

已知限制：无图形配置界面，配置写在 `proxy-switch.json` 或 `cordis.patch.yml`。