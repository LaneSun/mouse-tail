// Style engine: a pure-JS module shared by the extension and prefs,
// with no GI dependencies.
//
// Model: a "style" consists of two patches relative to factory defaults:
// - defaults: settings patch for the default (light) state
// - dark: override patch applied on top of defaults in dark style only
// An empty patch {} is equivalent to factory defaults; preset selection
// is decided by deep comparison of the patches.

export const SETTING_KEYS = [
  "fade-duration",
  "line-width",
  "color",
  "alpha",
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
  "color-mode": ["solid", "rainbow-fixed", "rainbow-ratio", "rainbow-time"],
};

// -- Built-in presets (defaults/dark are patches relative to factory defaults) --
export const BUILTIN_STYLES = [
  {
    id: "basic",
    name: "Basic",
    defaults: { color: [0.0, 0.0, 0.0], alpha: 1.0 },
    dark: { color: [1.0, 1.0, 1.0] },
  },
  {
    id: "spark",
    name: "Spark",
    defaults: {
      color: [0.863, 0.078, 0.235], // #DC143C crimson
      alpha: 1.0,
      "line-width": 2,
    },
    dark: { color: [1.0, 0.843, 0.0] }, // #FFD700 gold
  },
  {
    id: "aurora",
    name: "Aurora",
    defaults: {
      "color-mode": "rainbow-time",
      // 0.65x brightness of the dark-side default palette (slightly
      // deeper on light backgrounds)
      "rainbow-time-config": "#A64646 500\n#33857F 500\n#A69647 500",
      "line-width": 8,
      alpha: 1.0,
    },
    dark: {
      "rainbow-time-config": "#FF6B6B 500\n#4ECDC4 500\n#FFE66D 500",
    },
  },
];

export function genId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// -- Validation and sanitizing (whitelist; doubles as prototype-pollution defense) --

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

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b)
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// -- Reading and computing --

// settingsLike must provide get_string, Gio.Settings-style
export function readStyleState(settingsLike) {
  const parse = (s) => {
    try {
      return sanitizeSettings(JSON.parse(s));
    } catch {
      return {};
    }
  };
  return {
    defaults: parse(settingsLike.get_string("style-defaults") || "{}"),
    dark: parse(settingsLike.get_string("style-dark-overrides") || "{}"),
  };
}

export function effectiveFor(state, isDark) {
  const eff = { ...FACTORY_DEFAULTS, ...state.defaults };
  if (isDark) Object.assign(eff, state.dark);
  return eff;
}

// -- Custom styles --
// User-created styles are explicit entities (id + patches), persisted in
// their own key; the picker tracks the active style by id and needs no
// state comparison.

// Returns the sanitized custom style list in creation order
export function readCustomStyles(settingsLike) {
  let list;
  try {
    list = JSON.parse(settingsLike.get_string("custom-styles") || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (style) =>
        style && typeof style === "object" && typeof style.id === "string",
    )
    .map((style) => ({
      id: style.id,
      defaults: sanitizeSettings(style.defaults),
      dark: sanitizeSettings(style.dark),
    }));
}

// Insert or replace (matched by id) a custom style
export function saveCustomStyle(settingsLike, style) {
  const list = readCustomStyles(settingsLike);
  const entry = {
    id: style.id,
    defaults: sanitizeSettings(style.defaults),
    dark: sanitizeSettings(style.dark),
  };
  const idx = list.findIndex((existing) => existing.id === style.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  settingsLike.set_string("custom-styles", JSON.stringify(list));
}

export function removeCustomStyle(settingsLike, id) {
  const list = readCustomStyles(settingsLike).filter(
    (style) => style.id !== id,
  );
  settingsLike.set_string("custom-styles", JSON.stringify(list));
}

// -- Write helpers (with pruning: keys are deleted when the value falls
// back to its baseline, keeping patches comparable to presets) --

// Change a default-state value: dropped when equal to factory default
export function setDefaultValue(state, key, value) {
  if (deepEqual(value, FACTORY_DEFAULTS[key])) delete state.defaults[key];
  else state.defaults[key] = value;
}

// Change a dark override: equal-to-default effective value means no override
export function setDarkValue(state, key, value) {
  const base = effectiveFor(state, false)[key];
  if (deepEqual(value, base)) delete state.dark[key];
  else state.dark[key] = value;
}

// -- One-time migration: legacy flat keys -> default-state patch (dark
// overrides start empty) --

export function ensureStyleMigrated(settingsLike) {
  if (settingsLike.get_int("settings-version") >= 2) return false;

  const legacy = {
    "fade-duration": settingsLike.get_int("fade-duration"),
    "line-width": settingsLike.get_int("line-width"),
    color: settingsLike.get_value("color").deep_unpack(),
    alpha: settingsLike.get_double("alpha"),
    "color-mode": settingsLike.get_string("color-mode"),
    "rainbow-fixed-config": settingsLike.get_string("rainbow-fixed-config"),
    "rainbow-ratio-config": settingsLike.get_string("rainbow-ratio-config"),
    "rainbow-time-config": settingsLike.get_string("rainbow-time-config"),
  };

  const defaults = {};
  for (const key of Object.keys(legacy)) {
    if (!deepEqual(legacy[key], FACTORY_DEFAULTS[key]))
      defaults[key] = legacy[key];
  }

  settingsLike.set_string("style-defaults", JSON.stringify(defaults));
  settingsLike.set_string("style-dark-overrides", "{}");
  settingsLike.set_int("settings-version", 2);
  return true;
}

// -- Rainbow configs: parsing/color lookup (shared by renderer and prefs preview) --

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

// Parses into {stops, period}; malformed lines are skipped (renderer-side
// tolerance; prefs validates before saving)
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

// rainbow-fixed / rainbow-ratio: value is the (normalized) distance from
// the trail's end
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

// rainbow-time: color cycles over time, wrapping end to start
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
