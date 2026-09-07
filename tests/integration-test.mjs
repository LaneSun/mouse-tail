// gjs 集成测试：真实 schema + 内存后端 + 引擎全链路。
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
  ensureMigrated,
  parseProfiles,
  effectiveSettings,
} from "../profileEngine.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok " : "FAIL"}  ${label}${cond ? "" : "  → " + detail}`);
  if (!cond) failed++;
};

const s = new Gio.Settings({
  schema_id: "org.gnome.shell.extensions.mouse-tail",
});

// 1) 出厂状态与迁移
check("factory profiles is []", s.get_string("profiles") === "[]");
check("factory version is 0", s.get_int("profile-system-version") === 0);
s.set_int("line-width", 12);
s.set_value("color", new GLib.Variant("ad", [0.2, 0.4, 0.6]));
check("migration runs", ensureMigrated(s) === true);
check("migration idempotent", ensureMigrated(s) === false);
const migrated = parseProfiles(s.get_string("profiles"));
check(
  "custom values carried, factory-equal dropped",
  migrated.length === 1 &&
    migrated[0].settings["line-width"] === 12 &&
    JSON.stringify(migrated[0].settings.color) === "[0.2,0.4,0.6]" &&
    !("alpha" in migrated[0].settings),
  JSON.stringify(migrated[0].settings),
);

// 2) 多规则级联
const profiles = [
  { id: "default", name: "Default", conditions: {}, settings: { "line-width": 12, color: [0.2, 0.4, 0.6] } },
  { id: "dark", name: "Dark rule", conditions: { "color-scheme": "dark" }, settings: { color: [1, 1, 1], alpha: 0.8 } },
  { id: "night", name: "Night rule", conditions: { "color-scheme": "dark", time: { from: 1200, to: 360 } }, settings: { "line-width": 4 } },
  { id: "ff", name: "Firefox rule", conditions: { "wm-class": ["firefox"] }, settings: { alpha: 0.3 } },
];
s.set_string("profiles", JSON.stringify(profiles));
const at = (ctx) => effectiveSettings(parseProfiles(s.get_string("profiles")), ctx);

let r = at({ workspace: 0, colorScheme: "dark", minuteOfDay: 1250, wmClass: null });
check("night wins by specificity", r.winner.id === "night");
check("cascade patches", r.effective["line-width"] === 4 && r.effective.alpha === 0.8 && JSON.stringify(r.effective.color) === "[1,1,1]");

r = at({ workspace: 0, colorScheme: "dark", minuteOfDay: 700, wmClass: "Chromium" });
check("dark wins midday, line-width falls through", r.winner.id === "dark" && r.effective["line-width"] === 12);

r = at({ workspace: 0, colorScheme: "light", minuteOfDay: 700, wmClass: null });
check("light → default", r.winner.id === "default" && r.effective.alpha === 0.5);

r = at({ workspace: 0, colorScheme: "dark", minuteOfDay: 700, wmClass: "firefox-esr" });
check("tie → later in list wins", r.winner.id === "ff" && r.effective.alpha === 0.3);

// 3) 写入键可用
s.set_string("active-profile", '{"winner":"Night rule","effective":{}}');
s.set_string("seen-wm-classes", '["firefox","code"]');
check("aux keys writable", s.get_string("seen-wm-classes") === '["firefox","code"]');

console.log(failed === 0 ? "\nINTEGRATION PASS" : `\n${failed} FAILED`);
System.exit(failed === 0 ? 0 : 1);
