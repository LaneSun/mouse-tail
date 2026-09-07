import {
  parseProfiles, specificity, effectiveSettings, matchesConditions,
  timeMatches, collectTimeBoundaries, ensureMigrated, makeDefaultProfile,
  parseTimeOfDay, formatMinute, parseRainbowStops, colorAtStops, timeColorAt,
  validateRainbowText, sanitizeSettings, genId,
} from "../profileEngine.js";

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n    expected: ${b}\n    actual:   ${a}`); }
}

// —— parseProfiles 容错 ——
console.log("parseProfiles:");
{
  const ps = parseProfiles("not json");
  eq(ps.length, 1, "invalid json → only Default");
  eq(ps[0].id, "default", "invalid json → Default first");

  const ps2 = parseProfiles(JSON.stringify([
    { id: "a", name: "A", conditions: {}, settings: { "line-width": 3 } },
    { id: "default", conditions: { "color-scheme": "dark" }, settings: {} },
    null,
    { noId: true },
    { id: "default", name: "dup" },
    { id: "b", settings: { "render-mode": "bogus", alpha: 9 } },
  ]));
  eq(ps2.length, 3, "bad entries dropped, dup default kept once");
  eq(ps2[0].id, "default", "default moved to front");
  eq(ps2[0].conditions, {}, "default conditions forced empty");
  eq(ps2[2].settings, { alpha: 1 }, "bogus enum dropped, alpha clamped");
}

// —— 特异性与级联 ——
console.log("cascade:");
{
  const profiles = [
    makeDefaultProfile({ "line-width": 10, color: [1, 0, 0] }),
    { id: "t1", name: "1cond", conditions: { "color-scheme": "dark" }, settings: { color: [0, 1, 0] } },
    { id: "t2", name: "2cond", conditions: { "color-scheme": "dark", workspaces: [1] }, settings: { "line-width": 2 } },
    { id: "t3", name: "tie-later", conditions: { "color-scheme": "dark" }, settings: { alpha: 0.9 } },
  ];
  const ctx = { workspace: 1, colorScheme: "dark", minuteOfDay: 600, wmClass: null };
  const { effective, winner } = effectiveSettings(profiles, ctx);
  eq(winner.id, "t2", "highest specificity wins");
  eq(effective["line-width"], 2, "patch from 2-cond rule");
  eq(effective.color, [0, 1, 0], "unset in t2 falls to t1 (same 1-cond, t1 later than default)");
  eq(effective.alpha, 0.9, "tie between t1/t3 → later in list (t3) wins");
  eq(specificity(profiles[2]), 2, "specificity = condition count");

  // ctx null = 全命中（prefs 继承展示用）
  const all = effectiveSettings(profiles, null);
  eq(all.winner.id, "t2", "null ctx matches all");

  // 不命中
  eq(matchesConditions(profiles[1], { workspace: 0, colorScheme: "light", minuteOfDay: 0, wmClass: null }), false, "scheme mismatch");
  const lightCtx = { workspace: 9, colorScheme: "light", minuteOfDay: 0, wmClass: null };
  const r2 = effectiveSettings(profiles, lightCtx);
  eq(r2.winner.id, "default", "no match → default wins");
  eq(r2.effective["line-width"], 10, "default settings apply");
}

// —— wm-class 子串匹配 ——
console.log("wm-class:");
{
  const p = { id: "w", conditions: { "wm-class": ["firefox", "Code"] }, settings: {} };
  eq(matchesConditions(p, { workspace: 0, colorScheme: "light", minuteOfDay: 0, wmClass: "Firefox-esr" }), true, "case-insensitive substring");
  eq(matchesConditions(p, { workspace: 0, colorScheme: "light", minuteOfDay: 0, wmClass: "code-url-handler" }), true, "lowercased storage matches");
  eq(matchesConditions(p, { workspace: 0, colorScheme: "light", minuteOfDay: 0, wmClass: "chromium" }), false, "no match");
  eq(matchesConditions(p, { workspace: 0, colorScheme: "light", minuteOfDay: 0, wmClass: null }), false, "null wmClass never matches");
}

// —— 时间 ——
console.log("time:");
{
  eq(parseTimeOfDay("9:05"), 545, "parse H:MM");
  eq(parseTimeOfDay("24:00"), null, "hour 24 invalid");
  eq(parseTimeOfDay("09:60"), null, "minute 60 invalid");
  eq(formatMinute(1380), "23:00", "format");
  eq(timeMatches({ from: 540, to: 1080 }, 540), true, "[540,1080) includes 540");
  eq(timeMatches({ from: 540, to: 1080 }, 1080), false, "half-open excludes to");
  eq(timeMatches({ from: 1320, to: 360 }, 1439), true, "wrap late night");
  eq(timeMatches({ from: 1320, to: 360 }, 300), true, "wrap early morning");
  eq(timeMatches({ from: 1320, to: 360 }, 700), false, "wrap midday out");
  eq(timeMatches({ from: 600, to: 600 }, 600), true, "from==to matches that minute");
  const b = collectTimeBoundaries([
    { conditions: { time: { from: 540, to: 1080 } }, settings: {} },
    { conditions: { time: { from: 1320, to: 360 } }, settings: {} },
  ]);
  eq(b.sort((x, y) => x - y), [360, 540, 1080, 1320], "boundaries collected");
}

// —— 迁移 ——
console.log("migration:");
{
  const store = {
    "profile-system-version": 0,
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
  eq(ensureMigrated(fake), true, "migrates once");
  eq(ensureMigrated(fake), false, "idempotent");
  eq(store["profile-system-version"], 1, "version stamped");
  const ps = parseProfiles(store.profiles);
  eq(ps.length, 1, "single default profile");
  eq(ps[0].settings, { "line-width": 12, color: [0.2, 0.4, 0.6] }, "only non-default values carried");
}

// —— 彩虹 ——
console.log("rainbow:");
{
  eq(validateRainbowText("rainbow-fixed", "#FF6B6B 500\n#FFE66D"), null, "fixed: last no param ok");
  eq(typeof validateRainbowText("rainbow-ratio", "#FF6B6B 500\n#FFE66D"), "string", "ratio: last needs param");
  eq(typeof validateRainbowText("rainbow-fixed", "red 500\n#FFE66D 5"), "string", "bad hex rejected");

  const fixed = parseRainbowStops("rainbow-fixed", "#FF0000 100\n#0000FF");
  eq(fixed.stops.map(s => s.length), [100, Infinity], "fixed last infinite");
  eq(fixed.stops[0].param, 100, "param accumulated");

  const ratio = parseRainbowStops("rainbow-ratio", "#FF0000 1\n#00FF00 3");
  eq(ratio.stops.map(s => s.length), [0.25, 0.75], "ratio normalized");
  eq(colorAtStops(ratio.stops, 0), [1, 0, 0], "color at 0");
  const mid = colorAtStops(ratio.stops, 0.125);
  eq(mid.map(v => Math.round(v * 1000)), [500, 500, 0], "color at first-segment midpoint");

  const t = parseRainbowStops("rainbow-time", "#FF0000 500\n#0000FF 500");
  eq(t.period, 1000, "time period");
  eq(timeColorAt(t, 0), [1, 0, 0], "time at 0");
  eq(timeColorAt(t, 1500), [0, 0, 1], "wraps by period (1500 ≡ 500 = start of second stop)");
  const half = timeColorAt(t, 750);
  eq(half.map(v => Math.round(v * 1000)), [500, 0, 500], "time midpoint");
}

// —— 杂项 ——
console.log("misc:");
{
  eq(sanitizeSettings({ "fade-duration": 100000, "line-width": 0.6, alpha: -1, "render-mode": "fast" }),
    { "fade-duration": 2000, "line-width": 1, alpha: 0, "render-mode": "fast" }, "clamping");
  eq(genId().startsWith("p-"), true, "id prefix");
}

// —— 安全：profiles 是用户可经 dconf 直接写入的 JSON，
// 级联前的白名单净化必须挡掉原型污染与任意键注入 ——
console.log("hardening:");
{
  const evil = JSON.stringify([
    { id: "default", settings: {} },
    {
      id: "x",
      settings: { "__proto__": { polluted: true }, constructor: 1, "line-width": 5 },
      conditions: { "__proto__": 1, bogus: "x" },
    },
  ]);
  const ps = parseProfiles(evil);
  eq(ps[1].settings, { "line-width": 5 }, "proto/constructor/extraneous keys dropped from settings");
  eq(ps[1].conditions, {}, "unknown condition keys dropped");
  eq(({}).polluted, undefined, "no prototype pollution");
  eq(effectiveSettings(ps, null).effective["line-width"], 5, "valid values still apply");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
