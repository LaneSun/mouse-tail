import {
  FACTORY_DEFAULTS,
  BUILTIN_STYLES,
  sanitizeSettings,
  deepEqual,
  effectiveFor,
  stateMatches,
  setDefaultValue,
  setDarkValue,
  ensureStyleMigrated,
  parseRainbowStops,
  colorAtStops,
  timeColorAt,
  validateRainbowText,
} from "../styleEngine.js";

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n    expected: ${b}\n    actual:   ${a}`); }
}

// —— 计算模型 ——
console.log("effective:");
{
  const st = { defaults: { color: [0, 0, 0], alpha: 0.9 }, dark: { color: [1, 1, 1] } };
  const light = effectiveFor(st, false);
  const dark = effectiveFor(st, true);
  eq(light.color, [0, 0, 0], "light uses defaults");
  eq(light.alpha, 0.9, "light patch applied");
  eq(dark.color, [1, 1, 1], "dark overrides color");
  eq(dark.alpha, 0.9, "dark inherits non-overridden");
  eq(effectiveFor({ defaults: {}, dark: {} }, true), FACTORY_DEFAULTS, "empty patches = factory");
}

// —— 匹配与剪枝 ——
console.log("matching:");
{
  eq(stateMatches({ defaults: {}, dark: {} }, BUILTIN_STYLES[0]), false, "empty state matches no preset");

  const st = { defaults: {}, dark: {} };
  setDefaultValue(st, "color", [0, 0, 0]);
  setDefaultValue(st, "alpha", 1.0);
  eq(st.defaults, { color: [0, 0, 0], alpha: 1 }, "default write stored");
  setDefaultValue(st, "alpha", 0.5); // 等于工厂值
  eq("alpha" in st.defaults, false, "factory-equal default pruned");
  setDefaultValue(st, "alpha", 1.0); // 恢复 Basic 的完整补丁
  setDarkValue(st, "color", [0, 0, 0]); // 等于默认状态生效值
  eq("color" in st.dark, false, "override equal to default pruned");
  setDarkValue(st, "color", [1, 1, 1]);
  eq(st.dark, { color: [1, 1, 1] }, "distinct override kept");
  eq(stateMatches(st, BUILTIN_STYLES[0]), true, "edited state now matches Basic");
}

// —— 内置预设效果 ——
console.log("preset effects:");
{
  eq(effectiveFor(BUILTIN_STYLES[0], false).color, [0, 0, 0], "Basic light is black");
  eq(effectiveFor(BUILTIN_STYLES[0], true).color, [1, 1, 1], "Basic dark is white");
  eq(effectiveFor(BUILTIN_STYLES[1], true)["line-width"], 2, "Spark thin line in dark too");
  eq(effectiveFor(BUILTIN_STYLES[1], true).alpha, 1, "Spark alpha inherited in dark");
  eq(effectiveFor(BUILTIN_STYLES[0], true).alpha, 1, "Basic full opacity");
  eq(effectiveFor(BUILTIN_STYLES[2], true).alpha, 1, "Aurora full opacity");
  eq(effectiveFor(BUILTIN_STYLES[2], false)["line-width"], 8, "Aurora line width 8");
  eq(effectiveFor(BUILTIN_STYLES[2], false)["rainbow-time-config"].startsWith("#A64646"), true, "Aurora light config is darkened");
  eq(effectiveFor(BUILTIN_STYLES[2], true)["rainbow-time-config"].startsWith("#FF6B6B"), true, "Aurora dark uses default time colors");
}

// —— 内置预设合法性 ——
console.log("presets:");
{
  for (const p of BUILTIN_STYLES) {
    eq(deepEqual(p.defaults, sanitizeSettings(p.defaults)), true, `preset ${p.id} defaults sanitized-stable`);
    eq(deepEqual(p.dark, sanitizeSettings(p.dark)), true, `preset ${p.id} dark sanitized-stable`);
    const eff = effectiveFor(p, true);
    eq(eff["color-mode"] !== undefined, true, `preset ${p.id} effective complete`);
  }
}

// —— 净化（含原型污染防线）——
console.log("sanitize:");
{
  eq(sanitizeSettings({ "fade-duration": 100000, "line-width": 0.6, alpha: -1, "render-mode": "fast" }),
    { "fade-duration": 2000, "line-width": 1, alpha: 0 }, "clamping (render-mode 已移除,白名单丢弃)");
  eq(sanitizeSettings({ "__proto__": { polluted: true }, constructor: 1, "line-width": 5 }),
    { "line-width": 5 }, "proto/constructor/extraneous keys dropped");
  eq(({}).polluted, undefined, "no prototype pollution");
  eq(deepEqual([1, [2, 3]], [1, [2, 3]]), true, "deepEqual arrays");
  eq(deepEqual({ a: 1 }, { a: 2 }), false, "deepEqual mismatch");
}

// —— 迁移（v0 扁平键）——
console.log("migration:");
{
  const store = {
    "settings-version": 0,
    "fade-duration": 200, "line-width": 12,
    color: [0.2, 0.4, 0.6], alpha: 0.5,
    "render-mode": "precise", "color-mode": "solid",
    "rainbow-fixed-config": "#FF6B6B 500\n#4ECDC4 500\n#FFE66D",
    "rainbow-ratio-config": "#FF6B6B 1\n#4ECDC4 1\n#FFE66D 1",
    "rainbow-time-config": "#FF6B6B 500\n#4ECDC4 500\n#FFE66D 500",
  };
  const fake = {
    get_int: (k) => store[k],
    get_string: (k) => store[k],
    get_double: (k) => store[k],
    get_value: (k) => ({ deep_unpack: () => store[k] }),
    set_string: (k, v) => { store[k] = v; },
    set_int: (k, v) => { store[k] = v; },
  };
  eq(ensureStyleMigrated(fake), true, "migrates once");
  eq(ensureStyleMigrated(fake), false, "idempotent");
  eq(store["settings-version"], 2, "version stamped");
  eq(JSON.parse(store["style-defaults"]), { "line-width": 12, color: [0.2, 0.4, 0.6] }, "non-default values carried");
  eq(JSON.parse(store["style-dark-overrides"]), {}, "dark overrides start empty");
}

// —— 彩虹 ——
console.log("rainbow:");
{
  eq(validateRainbowText("rainbow-fixed", "#FF6B6B 500\n#FFE66D"), null, "fixed: last no param ok");
  eq(typeof validateRainbowText("rainbow-ratio", "#FF6B6B 500\n#FFE66D"), "string", "ratio: last needs param");
  const ratio = parseRainbowStops("rainbow-ratio", "#FF0000 1\n#00FF00 3");
  eq(ratio.stops.map(s => s.length), [0.25, 0.75], "ratio normalized");
  eq(colorAtStops(ratio.stops, 0.125).map(v => Math.round(v * 1000)), [500, 500, 0], "color midpoint");
  const t = parseRainbowStops("rainbow-time", "#FF0000 500\n#0000FF 500");
  eq(t.period, 1000, "time period");
  eq(timeColorAt(t, 0), [1, 0, 0], "time at 0");
  eq(timeColorAt(t, 1500), [0, 0, 1], "wraps by period");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
