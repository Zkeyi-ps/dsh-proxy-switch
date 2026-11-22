/**
 * dsh-proxy-switch — 浏览器半侧：插件页里 dsh-proxy-switch 卡片自己的配置页。
 *
 * 配置写回 profile 的 cordis.patch.yml 里这一行的 config，由宿主的 ConfigEditor 负责落盘。
 * 手写 react.createElement，不依赖 JSX 构建。
 */
window.__ModuleLoader__.load({
  id: "dsh-proxy-switch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = react.createElement;

    /** 本页文案的字典命名空间（与配置命名空间无关）。 */
    const NS = "settings.proxySwitch";

    /** 配置命名空间 = profile 里这一行的 loader 行 id。 */
    const CONFIG_NS = "dsh-proxy-switch";

    /** 卡片所属的组合包名，作为 plugins.bundle.config 的 key。 */
    const BUNDLE = "dsh-proxy-switch";

    /** cordis fiber 需要注入的服务。 */
    const inject = ["slots", "locale", "configForms"];

    const en = {
      title: "Proxy switch",
      description: "Probe a local proxy port at runtime and mount or unmount the host's outbound HTTP proxy policy.",
      proxyPort: "Proxy port",
      proxyPortHint: "0 probes the candidate list below automatically. Set a number to lock one port.",
      probeIntervalSec: "Re-probe interval",
      probeIntervalSecHint: "Seconds between probes. Minimum 5.",
      overridden: "Overridden",
      reset: "Reset",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      save: "Save",
      saving: "Saving\u2026",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      invalidNumber: "Enter a number, or leave blank to use the default.",
    };

    const zh = {
      title: "代理开关",
      description: "运行时探测本地代理端口，自动挂载或卸载宿主的出站 HTTP 代理策略。",
      proxyPort: "代理端口",
      proxyPortHint: "填 0 表示按下面的候选列表自动探测；填具体数字则只探这一个端口。",
      probeIntervalSec: "复查间隔",
      probeIntervalSecHint: "两次探测之间的秒数，最小 5 秒。",
      overridden: "已覆盖",
      reset: "恢复默认",
      readOnly: "本部署的设置为只读。",
      unavailable: "该插件当前未加载，暂时无法配置。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      invalidNumber: "请填数字；留空表示使用默认值。",
    };

    /** 表单框架的文案。 */
    function formLabels(t) {
      return {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving"),
      };
    }

    /** 一个数字字段，三个属性完全相同，只差字段名与文案。 */
    function numberField(props, state, field, labelKey, hintKey) {
      return primitives.SettingsValueField({
        id: "plugin-config-proxy-switch-" + field,
        label: props.t(labelKey),
        hint: props.t(hintKey),
        overriddenLabel: props.t("overridden"),
        resetLabel: props.t("reset"),
        invalidLabel: props.t("invalidNumber"),
        numeric: true,
        disabled: !state.writable,
        ...state[field],
        onEdit: (text) => props.edit(field, text),
        onReset: () => props.resetField(field),
      });
    }

    /** 插件页里那张卡片：摘要视图给一行字，页面视图给表单。 */
    function ProxySwitchCard(props) {
      const state = props.useProxySwitchCard((snapshot) => snapshot);
      if (props.view === "summary") return props.t("description");
      return primitives.SettingsForm({
        labels: formLabels(props.t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          numberField(props, state, "proxyPort", "proxyPort", "proxyPortHint"),
          numberField(props, state, "probeIntervalSec", "probeIntervalSec", "probeIntervalSecHint"),
        ],
      });
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-proxy-switch: dictionaries");

      const scope = ctx.configForms.get(CONFIG_NS);
      const form = new primitives.SettingsFormModel(
        scope,
        [primitives.settingsNumberField("proxyPort"), primitives.settingsNumberField("probeIntervalSec")],
        [],
      );
      const store = form.bind(() => ({
        ...form.shell(),
        proxyPort: form.field("proxyPort"),
        probeIntervalSec: form.field("probeIntervalSec"),
      }));

      ctx.effect(() => () => { form.dispose(); }, "dsh-proxy-switch: form subscription");

      ctx.effect(
        () => ctx.configForms.whileServed([CONFIG_NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
          name: "plugins.bundle.config",
          key: BUNDLE,
          locale: NS,
          inject: () => ({ hooks: { proxySwitchCard: store }, ...form.actions() }),
        }, ProxySwitchCard))),
        "dsh-proxy-switch: config page",
      );
    }

    exports.NS = NS;
    exports.CONFIG_NS = CONFIG_NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});