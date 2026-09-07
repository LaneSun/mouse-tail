// Profile 条件级联引擎：extension 与 prefs 共用的纯 JS 模块，无 GI 依赖。
//
// 语义（对齐 CSS）：
// - Profile = 条件集 + 设置补丁；特异性 = 已启用条件数，越多优先级越高；
//   同特异性时列表靠后者胜。
// - 级联以工厂默认值为基底，命中规则按优先级从低到高叠加补丁，
//   等价于"从最高优先级取设置，未设置项落到更低优先级规则"。
// - Default Profile（id "default"）无条件、恒命中、不可删除，充当级联基准。

export const DEFAULT_PROFILE_ID = "default";

export const SETTING_KEYS = [
  "fade-duration",
  "line-width",
  "color",
  "alpha",
  "render-mode",
  "color-mode",
  "rainbow-fixed-config",
  "rainbow-ratio-config",
  "rainbow-time-config",
];

export const FACTORY_DEFAULTS = {
  "fade-duration": 200,
  "line-width": 8,
  color: [1.0, 1.0, 1.0],
  alpha: 0.5,
  "render-mode": "precise",
  "color-mode": "solid",
  "rainbow-fixed-config": "#FF6B6B 500\n#4ECDC4 500\n#FFE66D",
  "rainbow-ratio-config": "#FF6B6B 1\n#4ECDC4 1\n#FFE66D 1",
  "rainbow-time-config": "#FF6B6B 500\n#4ECDC4 500\n#FFE66D 500",
};

const INT_RANGES = {
  "fade-duration": [50, 2000],
  "line-width": [1, 20],
};

const ENUM_VALUES = {
  "render-mode": ["precise", "balance", "fast"],
  "color-mode": ["solid", "rainbow-fixed", "rainbow-ratio", "rainbow-time"],
};

export function genId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeDefaultProfile(settings = {}) {
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    conditions: {},
    settings: sanitizeSettings(settings),
  };
}

// —— 校验与净化 ——

export function sanitizeSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of SETTING_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (key in INT_RANGES) {
      if (typeof v === "number" && isFinite(v)) {
        const [min, max] = INT_RANGES[key];
        out[key] = Math.round(Math.min(max, Math.max(min, v)));
      }
    } else if (key === "color") {
      if (
        Array.isArray(v) &&
        v.length >= 3 &&
        v.slice(0, 3).every((x) => typeof x === "number" && isFinite(x))
      ) {
        out[key] = v.slice(0, 3).map((x) => Math.min(1, Math.max(0, x)));
      }
    } else if (key === "alpha") {
      if (typeof v === "number" && isFinite(v)) {
        out[key] = Math.min(1, Math.max(0, v));
      }
    } else if (key in ENUM_VALUES) {
      if (ENUM_VALUES[key].includes(v)) out[key] = v;
    } else {
      if (typeof v === "string") out[key] = v;
    }
  }
  return out;
}

export function sanitizeConditions(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  const scheme = raw["color-scheme"];
  if (scheme === "light" || scheme === "dark") out["color-scheme"] = scheme;

  if (Array.isArray(raw.workspaces)) {
    const ws = [
      ...new Set(
        raw.workspaces.filter((n) => Number.isInteger(n) && n >= 0),
      ),
    ].sort((a, b) => a - b);
    if (ws.length > 0) out.workspaces = ws;
  }

  const t = raw.time;
  if (
    t &&
    typeof t === "object" &&
    Number.isInteger(t.from) &&
    Number.isInteger(t.to) &&
    t.from >= 0 && t.from < 1440 &&
    t.to >= 0 && t.to < 1440
  ) {
    out.time = { from: t.from, to: t.to };
  }

  if (Array.isArray(raw["wm-class"])) {
    const seen = new Set();
    const arr = [];
    for (const s of raw["wm-class"]) {
      if (typeof s === "string" && s.trim()) {
        const low = s.trim().toLowerCase();
        if (!seen.has(low)) {
          seen.add(low);
          arr.push(low);
        }
      }
    }
    if (arr.length > 0) out["wm-class"] = arr;
  }

  return out;
}

// 无效条目返回 null；id 非法直接丢弃（无法可靠定位编辑）
export function sanitizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  return {
    id: raw.id,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : "Untitled",
    conditions: sanitizeConditions(raw.conditions),
    settings: sanitizeSettings(raw.settings),
  };
}

// —— 解析：容错并保证 Default 存在且居首（无条件）——

export function parseProfiles(json) {
  let raw = null;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) raw = [];

  const rest = [];
  let def = null;
  for (const item of raw) {
    const p = sanitizeProfile(item);
    if (!p) continue;
    if (p.id === DEFAULT_PROFILE_ID) {
      if (!def) {
        p.conditions = {};
        def = p;
      }
    } else {
      rest.push(p);
    }
  }
  return [def ?? makeDefaultProfile(), ...rest];
}

// —— 匹配与级联 ——

export function specificity(profile) {
  return Object.keys(profile.conditions).length;
}

// ctx: {workspace: int, colorScheme: "light"|"dark", minuteOfDay: int, wmClass: string|null}
// ctx 为 null 时视为全部命中（prefs 用于展示继承链，不依赖 shell 端上下文）
export function matchesConditions(profile, ctx) {
  if (!ctx) return true;
  const c = profile.conditions;

  if (c["color-scheme"] && c["color-scheme"] !== ctx.colorScheme) return false;

  if (c.workspaces && !c.workspaces.includes(ctx.workspace)) return false;

  if (c.time && !timeMatches(c.time, ctx.minuteOfDay)) return false;

  if (c["wm-class"]) {
    if (typeof ctx.wmClass !== "string") return false;
    const low = ctx.wmClass.toLowerCase();
    if (!c["wm-class"].some((w) => low.includes(w.toLowerCase()))) return false;
  }

  return true;
}

// 返回 {effective, winner}：winner 为优先级最高的命中规则（至少是 Default）
export function effectiveSettings(profiles, ctx) {
  const effective = { ...FACTORY_DEFAULTS };
  const matched = [];
  profiles.forEach((p, i) => {
    if (matchesConditions(p, ctx)) matched.push([p, i]);
  });
  // 升序应用：特异性小→大，同特异性按列表顺序（靠后者覆盖）
  matched.sort(
    (a, b) => specificity(a[0]) - specificity(b[0]) || a[1] - b[1],
  );
  let winner = null;
  for (const [p] of matched) {
    Object.assign(effective, p.settings);
    winner = p;
  }
  return { effective, winner };
}

// —— 时间条件 ——

// "H:MM" / "HH:MM" → 当天分钟数；非法返回 null
export function parseTimeOfDay(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatMinute(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// 区间语义 [from, to)：from < to 常规；from > to 跨零点（如 22:00–06:00）；
// from == to 视为仅命中该分钟（字面直读，UI 校验会提示避免这种写法）
export function timeMatches({ from, to }, minute) {
  if (from === to) return minute === from;
  if (from < to) return minute >= from && minute < to;
  return minute >= from || minute < to;
}

// 汇总所有时间条件的边界分钟数，供扩展调度下次重算时刻
export function collectTimeBoundaries(profiles) {
  const out = new Set();
  for (const p of profiles) {
    const t = p.conditions.time;
    if (t) {
      out.add(t.from);
      out.add(t.to);
    }
  }
  return [...out];
}

// —— 一次性迁移：扁平旧键 → Default Profile ——

// settingsLike 需提供 Gio.Settings 风格的 get_int/get_string/get_value/get_double
export function ensureMigrated(settingsLike) {
  if (settingsLike.get_int("profile-system-version") >= 1) return false;

  const legacy = {
    "fade-duration": settingsLike.get_int("fade-duration"),
    "line-width": settingsLike.get_int("line-width"),
    color: settingsLike.get_value("color").deep_unpack(),
    alpha: settingsLike.get_double("alpha"),
    "render-mode": settingsLike.get_string("render-mode"),
    "color-mode": settingsLike.get_string("color-mode"),
    "rainbow-fixed-config": settingsLike.get_string("rainbow-fixed-config"),
    "rainbow-ratio-config": settingsLike.get_string("rainbow-ratio-config"),
    "rainbow-time-config": settingsLike.get_string("rainbow-time-config"),
  };

  // 仅保留与工厂默认不同的项：没定制过的用户迁移后得到全"未设置"的 Default
  for (const key of Object.keys(legacy)) {
    if (JSON.stringify(legacy[key]) === JSON.stringify(FACTORY_DEFAULTS[key])) {
      delete legacy[key];
    }
  }

  settingsLike.set_string(
    "profiles",
    JSON.stringify([makeDefaultProfile(legacy)]),
  );
  settingsLike.set_int("profile-system-version", 1);
  return true;
}

// —— 彩虹配置：解析/取色（渲染端与 prefs 预览共用）——

export function validateRainbowText(mode, text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return "At least 2 color stops required.";

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    const hex = parts[0];
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      return `Line ${i + 1}: invalid hex color "${hex}". Use #RRGGBB format.`;
    }
    const isLast = i === lines.length - 1;
    const needsParam = !isLast || mode !== "rainbow-fixed";
    if (needsParam) {
      if (parts.length < 2) return `Line ${i + 1}: missing parameter.`;
      const param = parseFloat(parts[1]);
      if (isNaN(param) || param <= 0) {
        return `Line ${i + 1}: parameter must be a positive number.`;
      }
    }
  }
  return null;
}

// 解析为 {stops, period}；坏行跳过（渲染端容错，保存前由 prefs 校验）
export function parseRainbowStops(mode, text) {
  if (mode === "solid") return null;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const stops = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    const hex = parts[0];
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) continue;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    const isLast = i === lines.length - 1;
    const allowNoParam = isLast && mode === "rainbow-fixed";
    const hasParam = parts.length >= 2 && parts[1].length > 0;

    let length = 0;
    if (hasParam || !allowNoParam) {
      length = parseFloat(parts[1]);
      if (!isFinite(length) || length <= 0) length = 0;
      acc += length;
    } else {
      length = Infinity;
    }
    stops.push({ color: [r, g, b], length });
  }

  if (mode === "rainbow-ratio" && acc > 0) {
    stops.forEach((s) => {
      if (s.length !== Infinity) s.length /= acc;
    });
  }

  let acc2 = 0;
  for (const stop of stops) {
    acc2 += stop.length;
    stop.param = stop.length === Infinity ? Infinity : acc2;
  }

  return { stops, period: mode === "rainbow-time" ? acc : undefined };
}

export function lerpColor(c1, c2, t) {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
  ];
}

// rainbow-fixed / rainbow-ratio：value 为距轨迹末端的（归一化）距离
export function colorAtStops(stops, value) {
  if (!stops || stops.length === 0) return [1, 1, 1];

  let idx = 0;
  for (let i = 0; i < stops.length; i++) {
    if (value < stops[i].param) {
      idx = i;
      break;
    }
    idx = i + 1;
  }
  if (idx >= stops.length) return stops[stops.length - 1].color;

  const s1 = stops[idx];
  const s2 = stops[idx + 1] ?? s1;
  const prevParam = idx === 0 ? 0 : stops[idx - 1].param;
  const span = s1.param - prevParam;
  const t = span > 0 ? (value - prevParam) / span : 0;
  return lerpColor(s1.color, s2.color, t);
}

// rainbow-time：按时间循环取色，首尾相接
export function timeColorAt(parsed, elapsedMs) {
  const stops = parsed?.stops;
  if (!stops || stops.length < 2) return stops?.[0]?.color ?? [1, 1, 1];
  const period = parsed.period;
  if (!period || period <= 0) return stops[0].color;

  const t = elapsedMs % period;
  let accumulated = 0;
  let idx = 0;
  for (let i = 0; i < stops.length; i++) {
    accumulated += stops[i].length;
    if (t < accumulated) {
      idx = i;
      break;
    }
  }
  const prevAccumulated = accumulated - stops[idx].length;
  const localT =
    stops[idx].length > 0 ? (t - prevAccumulated) / stops[idx].length : 0;
  const nextIdx = (idx + 1) % stops.length;
  return lerpColor(stops[idx].color, stops[nextIdx].color, localT);
}
