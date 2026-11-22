# dsh-proxy-switch

A proxy switch for [DeepSeek Harness](https://www.deepseek.com/harness/): **probe a local proxy port at runtime and mount or unmount the host's outbound HTTP proxy policy — no restart.**

English | [中文](README.md)

---

## Why this exists

If you run an agent host like DeepSeek Harness outside the US, your day usually looks like this:

- **Model calls go to a regional API** — direct, fast
- **But the agent needs the internet** — docs, packages, GitHub — which needs a VPN
- **The VPN is usually off**, or on and then forgotten

So you hit the same wall every day:

> **DSH reads the proxy from the environment once, at startup, and never again.**

The consequences:

| What you do | What happens |
| --- | --- |
| Start with the VPN up, turn it off | Every web fetch times out on a dead proxy |
| Start with the VPN down, turn it on | Still broken — **you must restart DSH** |
| Every network change | Restart the agent, **lose the session context** |

This is not an edge case; it is the normal workflow. Other agent hosts (Claude Code, Cursor, Codex CLI) share the problem: **their network policy is per-process, while real-world connectivity changes all the time.**

This plugin turns that one-shot startup snapshot into a continuously maintained state: every 30 seconds it checks whether the proxy port is there, mounts the policy when it is, unmounts it when it is not — no restart, ever.

**Your model calls go over loopback and are unaffected** — only traffic that actually leaves the machine follows the VPN.
---

## The problem

DSH resolves its outbound proxy policy once, from the launch environment, through `@deepseek-ai/dsh-http-proxy`. After that it is fixed for the life of the process.

That creates a practical annoyance:

- Start DSH with the VPN up, then turn it off — every request stalls on a dead proxy
- Start DSH with the VPN down, then turn it on — external access stays broken until you restart

This plugin turns that one-shot resolution into a continuously maintained state.

## Behaviour

```
plugin loads
  │
  ├─ probe 127.0.0.1:7897
  │    ├─ reachable → install the proxy policy
  │    └─ unreachable → explicitly install the DIRECT policy
  │
  ├─ re-probe every 30s
  │    ├─ down → up   switch to the proxy
  │    └─ up → down   switch back to direct
  │
  └─ plugin disabled → dispose, restore the pre-load state
```

**Installing DIRECT explicitly matters.** If the host started with a proxy that has since died, a plain `dispose()` would restore that dead proxy. The plugin installs a policy for both directions.

## Install

```bash
dsh plugin add github:Zkeyi-ps/dsh-proxy-switch
```

Or manually: place this repository at `$DSH_HOME/profiles/<profile>/node_modules/dsh-proxy-switch`, then add the package name to that profile's `package.json` under both `dsh.profile.bundles` and `dependencies`.

Restart the host afterwards. The plugin appears under "Installed" on the Plugins page; its row toggle enables and disables it.

## Configuration

Open the dsh-proxy-switch card on the Plugins page: **the proxy port and re-probe interval are editable and saved right there**. The two ways below cover the fields the page does not show.

**Zero configuration by default.** The plugin probes common proxy ports in order and uses the first one that answers:

```
7897   Clash Verge (mixed port, most common)
7890   Clash / Clash for Windows (HTTP)
10809  v2rayN (HTTP)
8080   generic HTTP proxy
```

**Custom ports need no configuration either.** When none of the ports above answer, the plugin reads the ports actually listened on by local proxy clients (Clash / mihomo / Clash Verge / v2ray / xray / sing-box / shadowsocks / hysteria / nekoray / karing…), then sends a real `CONNECT` request to each candidate to confirm it really is an HTTP proxy — so a client's own API port (clash-verge's 33331, for example) is never mistaken for one.

If your proxy is not in that list, pick one of the two ways below.

### Option 1: `$DSH_HOME/proxy-switch.json` (recommended)

```
Windows:  C:\Users\<you>\.dsh\proxy-switch.json
macOS:    ~/.dsh/proxy-switch.json
```

```json
{
  "proxyHost": "127.0.0.1",
  "proxyPort": 8888
}
```

**No restart needed.** The file is re-read on every probe (30 s by default), and a changed port re-mounts the policy. Delete the file to fall back to auto-detection.

You can also just change the candidate list and keep auto-detection:

```json
{
  "proxyPorts": [8888, 7897, 1080]
}
```

### Option 2: `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-proxy-switch
      name: 'dsh-proxy-switch'
      config:
        proxyHost: 127.0.0.1
        proxyPort: 0             # 0 = auto-probe proxyPorts
        proxyPorts: [7897, 7890, 10809, 8080]
        probeIntervalSec: 30     # re-probe interval, minimum 5s
        probeTimeoutMs: 400      # per-probe TCP timeout
```

`proxyPort` above 0 probes only that port; 0 auto-probes `proxyPorts` in order.

Fields in `proxy-switch.json` override the values here.

With HMR enabled on the profile the change re-composes immediately; otherwise restart the host.

### Why it does not read the system proxy

DSH's `dsh-http-proxy` only accepts `http(s)://` proxy URLs from the environment. It does not read the Windows/macOS system proxy and does not support SOCKS or PAC. This plugin reuses that same policy, so the same limits apply.
## How it works

`@deepseek-ai/dsh-http-proxy` exports `installProxyFromEnvironment(env, report)`, which returns a **disposer**. The plugin uses it to mount and unmount the policy at runtime:

- `env` must be a snapshot from `createLaunchEnvironmentSnapshot()` (a `Map<name, {value}>`), not a plain object
- An empty proxy environment installs the **DIRECT** policy — that is the explicit direct mode
- The disposer restores the dispatcher, the policy, and `process.env` together

The module is located from the running executable:

```
dirname(process.execPath) / resources / app / dsh / node_modules
```

Override with the `DSH_APP_NODE_MODULES` environment variable when the install layout is unusual or the host runs as an `ELECTRON_RUN_AS_NODE` child.

## Compatibility

| Plugin | DSH |
| --- | --- |
| 0.1.0 | 0.2.0-rc.2 (developed and verified) |

This depends on public exports of the DSH-internal package `@deepseek-ai/dsh-http-proxy`. If a DSH upgrade changes those signatures, the plugin must follow.

## Known limitations

- **The settings page covers two fields** (proxy port, re-probe interval). The candidate port list and the process-discovery switch still live in `cordis.patch.yml` or `proxy-switch.json`.
- **HTTP proxies only.** SOCKS and PAC are unsupported — an upstream policy limit.
- **Does not manage the proxy client.** It probes a port; it does not start Clash or v2ray.
- **Loopback always bypasses the proxy.** Upstream behaviour: `localhost`, `127.0.0.0/8` and `::1` are never proxied, so DSH-to-local-gateway traffic is unaffected.

## Development

A host-only cordis plugin with no build step:

```
host/index.js       the host-side plugin (ESM; exports name and apply)
client.js           the browser-side settings page (window.__ModuleLoader__ format, hand-written createElement, no build step)
cordis.patch.yml    the bundle patch that inserts it into the profile tree
dsh.plugin.json     plugin manifest (description, contributions)
```

To verify locally, drop the directory into a profile's `node_modules`, register the package name in `dsh.profile.bundles`, and restart the host.
### Writing a DSH plugin with a settings page: three silent-failure contracts

Get any of these wrong and **nothing throws** — the page just stays empty. This project hit all three.

1. **The host only serves plugins that export `Config`.** Without it the plugin never enters the settings document's namespace list, and the page reports "not loaded".
2. **At least one `Config` field must be marked `.volatile()`.** The host's `volatileForm()` keeps only volatile fields; with none it returns `undefined` and the whole namespace is dropped.
3. **Inside `apply(ctx, config)` a volatile field is a runtime reference, not a value.** `Number(config.proxyPort)` yields `NaN` — use `config.proxyPort.get()`. This project uses `unwrap()` so both the schema-loaded and schema-missing cases work.

Two more:

- **`schemastery` is not in the profile's `node_modules`.** Derive the app's `node_modules` from `process.execPath`, load it dynamically, and build `Config` with a top-level `await`. On failure export `undefined`: the plugin still runs, it just has no settings page.
- **The browser half is not a normal ES module.** The format is `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`, with dependencies taken through `require()`. Hand-written `react.createElement` means no build step.

## License

MIT