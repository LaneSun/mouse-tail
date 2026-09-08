// gjs 集成测试：真实 schema + 内存后端 + 样式引擎全链路。
// 运行：gjs -m tests/integration-test.mjs（需要先执行 ./compile-schemas.sh）
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import System from "system";

// 自配置环境：schema 目录用仓库内编译产物，后端用内存（不污染真实 dconf）
const [thisFile] = GLib.filename_from_uri(import.meta.url);
const repoDir = thisFile.replace(/\/tests\/[^/]+$/, "");
GLib.setenv("GSETTINGS_SCHEMA_DIR", `${repoDir}/schemas`, true);
GLib.setenv("GSETTINGS_BACKEND", "memory", true);

import {
  ensureStyleMigrated,
  readStyleState,
  effectiveFor,
  readCustomStyles,
  saveCustomStyle,
  removeCustomStyle,
  genId,
  BUILTIN_STYLES,
} from "../styleEngine.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok " : "FAIL"}  ${label}${cond ? "" : "  → " + detail}`);
  if (!cond) failed++;
};

const s = new Gio.Settings({
  schema_id: "org.gnome.shell.extensions.mouse-tail",
});

// 1) 出厂状态与迁移（v0 扁平键）
check("factory state is empty patches", s.get_string("style-defaults") === "{}" && s.get_string("style-dark-overrides") === "{}");
s.set_int("line-width", 12);
s.set_value("color", new GLib.Variant("ad", [0.2, 0.4, 0.6]));
check("migration runs", ensureStyleMigrated(s) === true);
check("migration idempotent", ensureStyleMigrated(s) === false);
const st = readStyleState(s);
check("carried non-default values", st.defaults["line-width"] === 12 && JSON.stringify(st.defaults.color) === "[0.2,0.4,0.6]" && !("alpha" in st.defaults));
check("dark starts empty", Object.keys(st.dark).length === 0);

// 2) 激活预设（id 标记选中，样式键写入其补丁）
const apply = (id, style) => {
  s.set_string("style-defaults", JSON.stringify(style.defaults));
  s.set_string("style-dark-overrides", JSON.stringify(style.dark));
  s.set_string("active-style", id);
};
apply("basic", BUILTIN_STYLES[0]);
check("apply Basic writes patches + id",
  s.get_string("style-defaults") === JSON.stringify(BUILTIN_STYLES[0].defaults) &&
  s.get_string("active-style") === "basic");
check("Basic: light black / dark white",
  JSON.stringify(effectiveFor(readStyleState(s), false).color) === "[0,0,0]" &&
  JSON.stringify(effectiveFor(readStyleState(s), true).color) === "[1,1,1]");
apply("spark", BUILTIN_STYLES[1]);
check("Spark light is crimson", JSON.stringify(effectiveFor(readStyleState(s), false).color) === "[0.863,0.078,0.235]");

// 3) 自定义样式生命周期：基于当前状态派生 → 编辑覆写 → 删除
const custom = { id: genId(), ...readStyleState(s) };
custom.defaults["line-width"] = 5;
saveCustomStyle(s, custom);
apply(custom.id, custom);
const stored = readCustomStyles(s);
check("derived custom saved and listed", stored.length === 1 && stored[0].id === custom.id && stored[0].defaults["line-width"] === 5);
saveCustomStyle(s, { id: custom.id, defaults: { "fade-duration": 300 }, dark: {} });
check("re-save replaces in place", readCustomStyles(s).length === 1 && readCustomStyles(s)[0].defaults["fade-duration"] === 300);
removeCustomStyle(s, custom.id);
check("remove drops the entry", readCustomStyles(s).length === 0);

// 4) 坏数据容错
s.set_string("style-defaults", "{invalid json");
check("invalid json falls back to empty", Object.keys(readStyleState(s).defaults).length === 0);
s.set_string("custom-styles", "{invalid json");
check("invalid custom list falls back to empty", readCustomStyles(s).length === 0);

console.log(failed === 0 ? "\nINTEGRATION PASS" : `\n${failed} FAILED`);
System.exit(failed === 0 ? 0 : 1);
