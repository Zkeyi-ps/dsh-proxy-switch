# dsh-proxy-switch

A proxy switch for [DeepSeek Harness](https://www.deepseek.com/harness/): **probe a local proxy port at runtime and mount or unmount the host's outbound HTTP proxy policy — no restart.**

English | [中文](README.md)

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

In the profile's `cordis.patch.yml` (this package's own `cordis.patch.yml` supplies the defaults):

```yaml
- insert:
    - id: dsh-proxy-switch
      name: 'dsh-proxy-switch'
      config:
        proxyHost: 127.0.0.1     # proxy address
        proxyPort: 7897          # proxy port (Clash Verge default mixed port)
        probeIntervalSec: 30     # re-probe interval, minimum 5s
        probeTimeoutMs: 400      # per-probe TCP timeout
```

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

- **No settings UI yet.** Configuration lives in `cordis.patch.yml`. A `plugins.bundle.config` page is planned.
- **HTTP proxies only.** SOCKS and PAC are unsupported — an upstream policy limit.
- **Does not manage the proxy client.** It probes a port; it does not start Clash or v2ray.
- **Loopback always bypasses the proxy.** Upstream behaviour: `localhost`, `127.0.0.0/8` and `::1` are never proxied, so DSH-to-local-gateway traffic is unaffected.

## Development

A host-only cordis plugin with no build step:

```
host/index.js       the plugin (ESM; exports name and apply)
cordis.patch.yml    the bundle patch that inserts it into the profile tree
dsh.plugin.json     plugin manifest (description, contributions)
```

To verify locally, drop the directory into a profile's `node_modules`, register the package name in `dsh.profile.bundles`, and restart the host.

## License

MIT