import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import GObject from "gi://GObject";

import {
  ExtensionPreferences,
  gettext as _,
  ngettext,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
  DEFAULT_PROFILE_ID,
  genId,
  makeDefaultProfile,
  parseProfiles,
  effectiveSettings,
  ensureMigrated,
  specificity,
  parseTimeOfDay,
  formatMinute,
  parseRainbowStops,
  timeColorAt,
  validateRainbowText,
} from "./profileEngine.js";

import { drawTrail, calculatePointColors } from "./trailRender.js";

// 彩虹配置格式说明。gettext 只能在运行期调用，故做成函数而非模块级常量
function rainbowHint(mode) {
  switch (mode) {
    case "rainbow-fixed":
      return _(
        "Format per line: #RRGGBB distance(px). The last color does not need a distance.\nExample: red for 50px, then green for 50px, then blue forever.",
      );
    case "rainbow-ratio":
      return _(
        "Format per line: #RRGGBB ratio(positive number). Values are normalized automatically.\nExample: ratios 1, 1, 1 split the trail into three equal parts.",
      );
    case "rainbow-time":
      return _(
        "Format per line: #RRGGBB time(ms). All colors must have a time.\nExample: red for 500ms, then green for 500ms, then blue for 500ms.",
      );
    default:
      return "";
  }
}

// 一次性注入 chip 样式（徽标/标签的胶囊外观）
let chipCssAdded = false;
function ensureChipCss() {
  if (chipCssAdded) return;
  chipCssAdded = true;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(
    ".chip { border-radius: 9999px; padding: 3px 12px; min-height: 0px; " +
      "background: alpha(@window_fg_color, 0.10); font-weight: 500; } " +
      ".chip:hover { background: alpha(@window_fg_color, 0.18); }",
  );
  Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(),
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
  );
}

function stringList(labels) {
  const list = new Gtk.StringList();
  for (const label of labels) list.append(label);
  return list;
}

// 破坏性操作的二次确认：红色确认按钮的 Adw.AlertDialog
function confirmDestructive(parent, heading, body, actionLabel, onConfirm) {
  const dialog = new Adw.AlertDialog({
    heading,
    body,
    default_response: "cancel",
    close_response: "cancel",
  });
  dialog.add_response("cancel", _("Cancel"));
  dialog.add_response("confirm", actionLabel);
  dialog.set_response_appearance(
    "confirm",
    Adw.ResponseAppearance.DESTRUCTIVE,
  );
  dialog.choose(parent, null, (self, result) => {
    if (dialog.choose_finish(result) === "confirm") onConfirm();
  });
}

function colorToHex(c) {
  return (
    "#" +
    c
      .map((x) => Math.round(x * 255).toString(16).padStart(2, "0"))
      .join("")
  ).toUpperCase();
}

// —— 轨迹预览：按生效设置绘制一条两端渐隐的样例曲线 ——
const TrailPreview = GObject.registerClass(
  class TrailPreview extends Gtk.DrawingArea {
    _init() {
      super._init({
        height_request: 150,
        hexpand: true,
        margin_top: 10,
        margin_bottom: 6,
        margin_start: 12,
        margin_end: 12,
      });
      this._eff = null;
      this.set_draw_func((da, cr, w, h) => this._draw(cr, w, h));
    }

    setEffective(eff) {
      this._eff = eff;
      this.queue_draw();
    }

    // 完全复用扩展的渲染算法（trailRender.drawTrail）：
    // 合成一条带时间戳的正弦轨迹点列，新旧两端由算法自身的
    // 渐隐包络与速度因子自然处理，所见即所得。
    _draw(cr, w, h) {
      if (!this._eff) return;
      const eff = this._eff;

      const mode = eff["color-mode"];
      const fade = eff["fade-duration"];
      const now = Date.now();
      // 与扩展一致的采样密度：每 20ms 一个点
      const n = Math.max(24, Math.round(fade / 20));
      let parsed = null;
      if (mode !== "solid") {
        parsed = parseRainbowStops(
          mode,
          eff[`rainbow-${mode.replace("rainbow-", "")}-config`],
        );
      }

      const pts = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = 14 + t * (w - 28);
        const y = h / 2 + Math.sin(t * Math.PI * 2.2) * (h / 2 - 18);
        const ts = now - Math.round((1 - t) * fade);
        if (mode === "rainbow-time") {
          const [r, g, b] = timeColorAt(parsed, ts);
          pts.push([x, y, ts, r, g, b]);
        } else {
          pts.push([x, y, ts]);
        }
      }

      let pointColors = null;
      if (mode === "rainbow-fixed" || mode === "rainbow-ratio") {
        pointColors = calculatePointColors(pts, mode, parsed);
      }

      drawTrail(cr, pts, {
        size: eff["line-width"],
        fadeLength: fade,
        renderMode: eff["render-mode"],
        colorMode: mode,
        color: eff.color,
        alpha: eff.alpha,
        now,
        pointColors,
      });
    }
  },
);

export default class MouseTailPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    ensureChipCss();
    const settings = this.getSettings(
      "org.gnome.shell.extensions.mouse-tail",
    );
    ensureMigrated(settings);

    // 仅供展示的枚举名。gettext 只能在扩展上下文就绪后调用，
    // 因此这些映射必须留在 fillPreferencesWindow 内部
    const RENDER_LABELS = {
      precise: _("Precise"),
      balance: _("Balance"),
      fast: _("Fast"),
    };
    const COLOR_MODE_LABELS = {
      solid: _("Solid"),
      "rainbow-fixed": _("Fixed-length rainbow"),
      "rainbow-ratio": _("Ratio rainbow"),
      "rainbow-time": _("Time-based rainbow"),
    };

    const fmtValue = (key, v) => {
      switch (key) {
        case "fade-duration":
          return `${v} ms`;
        case "line-width":
          return `${v} px`;
        case "alpha":
          return `${Math.round(v * 100)} %`;
        case "color":
          return colorToHex(v);
        case "render-mode":
          return RENDER_LABELS[v] ?? v;
        case "color-mode":
          return COLOR_MODE_LABELS[v] ?? v;
        default: {
          const n = v
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0).length;
          return `${n} ${_("color stops")}`;
        }
      }
    };

    // 存储名 "Default"/"Untitled" 在显示层翻译，其余为用户数据原样展示
    const displayName = (name) =>
      name === "Default"
        ? _("Default")
        : name === "Untitled"
          ? _("Untitled")
          : name;

    let profiles = parseProfiles(settings.get_string("profiles"));

    const save = () => {
      settings.set_string("profiles", JSON.stringify(profiles));
      rebuildList();
    };

    // ———————————— 主页面 ————————————

    const page = new Adw.PreferencesPage({
      title: _("Profiles"),
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    // —— Hero 区：大尺寸轨迹预览 + 当前生效说明 ——
    const heroGroup = new Adw.PreferencesGroup();
    page.add(heroGroup);

    const preview = new TrailPreview();
    heroGroup.add(preview);

    const activeCaption = new Gtk.Label({
      label: _("Waiting for the extension…"),
      css_classes: ["dim-label", "caption"],
      halign: Gtk.Align.CENTER,
      margin_bottom: 10,
    });
    heroGroup.add(activeCaption);

    const updateStatus = () => {
      const raw = settings.get_string("active-profile");
      let info = null;
      try {
        info = raw ? JSON.parse(raw) : null;
      } catch {
        info = null;
      }
      if (info?.effective) {
        activeCaption.label = `${_("Currently Active")}: ${displayName(info.winner) || "—"}`;
        preview.setEffective(info.effective);
      } else {
        // 扩展未运行时退回本地级联结果（忽略条件，仅看优先级）
        activeCaption.label = _(
          "Extension is disabled — showing local preview",
        );
        preview.setEffective(effectiveSettings(profiles, null).effective);
      }
    };
    // prefs 对话框运行在独立进程中，窗口关闭进程即退出，
    // 无需为 settings 信号显式断开
    settings.connect("changed::active-profile", updateStatus);

    // Profile 列表
    const listGroup = new Adw.PreferencesGroup({
      title: _("Profiles"),
      description: _(
        "Rules with more active conditions take priority. " +
          "Options left unset fall through to lower-priority rules.",
      ),
    });
    page.add(listGroup);

    let listChildren = [];

    const conditionsSummary = (p) => {
      if (p.id === DEFAULT_PROFILE_ID)
        return _("Base settings — always applies");
      const parts = [];
      const c = p.conditions;
      if (c["color-scheme"])
        parts.push(c["color-scheme"] === "dark" ? _("Dark style") : _("Light style"));
      if (c.workspaces)
        parts.push(
          `${ngettext("Workspace", "Workspaces", c.workspaces.length)} ${c.workspaces.map((i) => i + 1).join(", ")}`,
        );
      if (c.time)
        parts.push(`${formatMinute(c.time.from)}–${formatMinute(c.time.to)}`);
      if (c["wm-class"]) parts.push(c["wm-class"].join(", "));
      return parts.length > 0
        ? parts.join("  ·  ")
        : _("No conditions (always applies)");
    };

    function rebuildList() {
      for (const child of listChildren) listGroup.remove(child);
      listChildren = [];

      profiles.forEach((p, i) => {
        const row = new Adw.ActionRow({
          title: displayName(p.name),
          subtitle: conditionsSummary(p),
        });

        if (p.id !== DEFAULT_PROFILE_ID) {
          const spec = specificity(p);
          const badge = new Gtk.Label({
            label: String(spec),
            css_classes: ["chip"],
            valign: Gtk.Align.CENTER,
            tooltip_text: _("Number of conditions (higher = higher priority)"),
          });
          row.add_suffix(badge);
        }

        // 同特异性时列表靠后者优先：提供上下移调整
        if (i > 1) {
          const up = new Gtk.Button({
            icon_name: "go-up-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: ["flat", "circular"],
            tooltip_text: _("Increase priority among equal-specificity rules"),
          });
          up.connect("clicked", () => {
            [profiles[i - 1], profiles[i]] = [profiles[i], profiles[i - 1]];
            save();
          });
          row.add_suffix(up);
        }
        if (i < profiles.length - 1) {
          const down = new Gtk.Button({
            icon_name: "go-down-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: ["flat", "circular"],
          });
          down.connect("clicked", () => {
            [profiles[i + 1], profiles[i]] = [profiles[i], profiles[i + 1]];
            save();
          });
          row.add_suffix(down);
        }

        row.activatable = true;
        row.connect("activated", () => openEditor(p.id));
        listGroup.add(row);
        listChildren.push(row);
      });

      const addRow = new Adw.ButtonRow({
        title: _("New Profile"),
        start_icon_name: "list-add-symbolic",
      });
      addRow.connect("activated", () => {
        const p = {
          id: genId(),
          name: _("New profile"),
          conditions: {},
          settings: {},
        };
        profiles.push(p);
        save();
        openEditor(p.id);
      });
      listGroup.add(addRow);
      listChildren.push(addRow);

      updateStatus();
    }

    // 重置组（沿用原设计：行尾红色按钮）
    const resetGroup = new Adw.PreferencesGroup();
    page.add(resetGroup);
    const resetRow = new Adw.ActionRow({
      title: _("Reset to Defaults"),
      subtitle: _("Restore all profiles to factory settings"),
    });
    const resetButton = new Gtk.Button({
      label: _("Reset"),
      valign: Gtk.Align.CENTER,
      css_classes: ["destructive-action"],
    });
    resetButton.connect("clicked", () => {
      confirmDestructive(
        window,
        _("Reset All Profiles?"),
        _(
          "All profiles and their settings will be restored to factory defaults.",
        ),
        _("Reset"),
        () => {
          profiles = [makeDefaultProfile()];
          save();
          window.add_toast(
            new Adw.Toast({ title: _("Profiles reset to factory defaults") }),
          );
        },
      );
    });
    resetRow.add_suffix(resetButton);
    resetGroup.add(resetRow);

    // ———————————— Profile 编辑子页面 ————————————

    function openEditor(profileId) {
      const idx = profiles.findIndex((p) => p.id === profileId);
      if (idx < 0) return;
      const profile = profiles[idx];
      const isDefault = profile.id === DEFAULT_PROFILE_ID;

      // 编辑器用模态 Adw.Dialog。Adw.Dialog 本身不渲染标题栏：
      // 放入 Adw.HeaderBar 后会自动显示对话框标题与关闭按钮
      // （官方 Header Bar Integration 行为）
      const epage = new Adw.PreferencesPage({ vexpand: true });
      const dialog = new Adw.Dialog({
        title: displayName(profile.name),
        content_width: 560,
        content_height: 620,
      });
      const dialogBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
      });
      dialogBox.append(new Adw.HeaderBar());
      dialogBox.append(epage);
      dialog.set_child(dialogBox);

      // 剔除本规则后的级联结果 = 各项"未设置"时展示的继承值
      const inheritedFor = (key) =>
        effectiveSettings(
          profiles.filter((p) => p.id !== profile.id),
          null,
        ).effective[key];

      // 名称
      const nameGroup = new Adw.PreferencesGroup();
      epage.add(nameGroup);
      const nameRow = new Adw.EntryRow({
        title: _("Name"),
        text: isDefault ? displayName(profile.name) : profile.name,
        sensitive: !isDefault,
      });
      nameRow.connect("changed", () => {
        profile.name = nameRow.text.trim() || "Untitled";
        dialog.title = displayName(profile.name);
        save();
      });
      nameGroup.add(nameRow);

      // —— 条件组 ——
      if (!isDefault) {
        const condGroup = new Adw.PreferencesGroup({
          title: _("Apply When"),
          description: _(
            "More active conditions = higher priority. " +
              "An empty list or a switched-off row means the condition is not set.",
          ),
        });
        epage.add(condGroup);

        const specRow = new Adw.ActionRow({
          title: _("Priority"),
          subtitle: "",
        });
        const specLabel = new Gtk.Label({
          css_classes: ["chip"],
          valign: Gtk.Align.CENTER,
        });
        specRow.add_suffix(specLabel);
        condGroup.add(specRow);
        const updateSpec = () => {
          const n = specificity(profile);
          specLabel.label = String(n);
          specRow.subtitle =
            n === 0
              ? _("Lowest — matches everything")
              : ngettext("1 condition", "%d conditions", n).format(n);
        };

        // 1) 系统主题
        {
          const row = new Adw.ActionRow({
            title: _("System Style"),
            subtitle: _("Match the GNOME light/dark style"),
          });
          const combo = new Gtk.DropDown({
            model: stringList([_("Light"), _("Dark")]),
            valign: Gtk.Align.CENTER,
            sensitive: "color-scheme" in profile.conditions,
          });
          const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
          if (profile.conditions["color-scheme"])
            combo.selected = profile.conditions["color-scheme"] === "dark" ? 1 : 0;
          sw.active = "color-scheme" in profile.conditions;
          sw.connect("notify::active", () => {
            combo.sensitive = sw.active;
            if (sw.active) {
              profile.conditions["color-scheme"] =
                combo.selected === 1 ? "dark" : "light";
            } else {
              delete profile.conditions["color-scheme"];
            }
            updateSpec();
            save();
          });
          combo.connect("notify::selected", () => {
            if (!sw.active) return;
            profile.conditions["color-scheme"] =
              combo.selected === 1 ? "dark" : "light";
            save();
          });
          row.add_suffix(combo);
          row.add_suffix(sw);
          condGroup.add(row);
        }

        // 2) 工作区（列表空 = 未设置）
        {
          const row = new Adw.ActionRow({
            title: _("Workspaces"),
            subtitle: _("Match when the current workspace is one of these"),
          });
          const chipsBox = new Gtk.Box({
            spacing: 4,
            valign: Gtk.Align.CENTER,
          });

          const rebuildChips = () => {
            let child = chipsBox.get_first_child();
            while (child) {
              const next = child.get_next_sibling();
              chipsBox.remove(child);
              child = next;
            }
            const ws = profile.conditions.workspaces ?? [];
            if (ws.length === 0) {
              const hint = new Gtk.Label({
                label: _("not set"),
                css_classes: ["dim-label"],
                valign: Gtk.Align.CENTER,
              });
              chipsBox.append(hint);
            } else {
              for (const w of ws) {
                const chip = new Gtk.Button({
                  label: String(w + 1),
                  css_classes: ["chip"],
                  valign: Gtk.Align.CENTER,
                  tooltip_text: _("Click to remove"),
                });
                chip.connect("clicked", () => {
                  const arr = profile.conditions.workspaces;
                  arr.splice(arr.indexOf(w), 1);
                  if (arr.length === 0) delete profile.conditions.workspaces;
                  rebuildChips();
                  updateSpec();
                  save();
                });
                chipsBox.append(chip);
              }
            }
          };

          const addBtn = new Gtk.MenuButton({
            icon_name: "list-add-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: ["flat", "circular"],
            tooltip_text: _("Add workspace"),
          });
          {
            const box = new Gtk.Box({
              orientation: Gtk.Orientation.VERTICAL,
              spacing: 8,
              margin_top: 8,
              margin_bottom: 8,
              margin_start: 8,
              margin_end: 8,
            });
            const spin = new Gtk.SpinButton({
              adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 36,
                step_increment: 1,
              }),
            });
            const applyBtn = new Gtk.Button({
              label: _("Add"),
              halign: Gtk.Align.END,
            });
            applyBtn.connect("clicked", () => {
              const v = spin.get_value_as_int() - 1;
              const arr = profile.conditions.workspaces ?? [];
              if (!arr.includes(v)) arr.push(v);
              arr.sort((a, b) => a - b);
              profile.conditions.workspaces = arr;
              rebuildChips();
              updateSpec();
              save();
              addBtn.popdown();
            });
            box.append(new Gtk.Label({ label: _("Workspace number:") }));
            box.append(spin);
            box.append(applyBtn);
            addBtn.popover = new Gtk.Popover({ child: box });
          }

          rebuildChips();
          row.add_suffix(chipsBox);
          row.add_suffix(addBtn);
          condGroup.add(row);
        }

        // 3) 时间段（开关 + HH:MM 两输入；跨零点如 22:00–06:00 合法）
        {
          const row = new Adw.ActionRow({
            title: _("Time of Day"),
            subtitle: _("Half-open range; from later than to wraps past midnight"),
          });
          const fromEntry = new Gtk.Entry({
            width_request: 72,
            valign: Gtk.Align.CENTER,
            placeholder_text: "HH:MM",
          });
          const dash = new Gtk.Label({ label: "–", valign: Gtk.Align.CENTER });
          const toEntry = new Gtk.Entry({
            width_request: 72,
            valign: Gtk.Align.CENTER,
            placeholder_text: "HH:MM",
          });
          const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });

          const setEntries = () => {
            const t = profile.conditions.time;
            fromEntry.sensitive = toEntry.sensitive = sw.active;
            fromEntry.text = t ? formatMinute(t.from) : "09:00";
            toEntry.text = t ? formatMinute(t.to) : "17:00";
            fromEntry.remove_css_class("error");
            toEntry.remove_css_class("error");
          };
          sw.active = "time" in profile.conditions;
          setEntries();

          const commitTime = () => {
            const from = parseTimeOfDay(fromEntry.text);
            const to = parseTimeOfDay(toEntry.text);
            // from == to 只匹配单独一分钟，实际无意义，按无效处理
            const equal = from !== null && to !== null && from === to;
            const ok = sw.active && from !== null && to !== null && !equal;
            fromEntry.toggle_css_class(
              "error",
              sw.active && (from === null || equal),
            );
            toEntry.toggle_css_class(
              "error",
              sw.active && (to === null || equal),
            );
            if (ok) {
              profile.conditions.time = { from, to };
              save();
            } else if ("time" in profile.conditions && !sw.active) {
              delete profile.conditions.time;
              updateSpec();
              save();
            }
          };
          sw.connect("notify::active", () => {
            if (sw.active) {
              // 开启时立即提交一次（输入框已预填合法值）
              commitTime();
              if (!("time" in profile.conditions)) {
                profile.conditions.time = { from: 540, to: 1020 };
                save();
              }
              setEntries();
              updateSpec();
            } else {
              delete profile.conditions.time;
              updateSpec();
              save();
            }
            setEntries();
          });
          fromEntry.connect("changed", commitTime);
          toEntry.connect("changed", commitTime);

          row.add_suffix(fromEntry);
          row.add_suffix(dash);
          row.add_suffix(toEntry);
          row.add_suffix(sw);
          condGroup.add(row);
        }

        // 4) 应用（wm_class 子串匹配；空列表 = 未设置）
        {
          const row = new Adw.ActionRow({
            title: _("Applications"),
            subtitle: _(
              "Match when the focused window's wm_class contains any of these",
            ),
          });
          const chipsBox = new Gtk.Box({
            spacing: 4,
            valign: Gtk.Align.CENTER,
          });

          const rebuildChips = () => {
            let child = chipsBox.get_first_child();
            while (child) {
              const next = child.get_next_sibling();
              chipsBox.remove(child);
              child = next;
            }
            const arr = profile.conditions["wm-class"] ?? [];
            if (arr.length === 0) {
              chipsBox.append(
                new Gtk.Label({
                  label: _("not set"),
                  css_classes: ["dim-label"],
                  valign: Gtk.Align.CENTER,
                }),
              );
            } else {
              for (const w of arr) {
                const chip = new Gtk.Button({
                  label: w,
                  css_classes: ["chip"],
                  valign: Gtk.Align.CENTER,
                  tooltip_text: _("Click to remove"),
                });
                chip.connect("clicked", () => {
                  const a = profile.conditions["wm-class"];
                  a.splice(a.indexOf(w), 1);
                  if (a.length === 0) delete profile.conditions["wm-class"];
                  rebuildChips();
                  updateSpec();
                  save();
                });
                chipsBox.append(chip);
              }
            }
          };

          const addBtn = new Gtk.MenuButton({
            icon_name: "list-add-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: ["flat", "circular"],
            tooltip_text: _("Add application"),
          });
          {
            const box = new Gtk.Box({
              orientation: Gtk.Orientation.VERTICAL,
              spacing: 8,
              margin_top: 8,
              margin_bottom: 8,
              margin_start: 8,
              margin_end: 8,
            });
            const entry = new Gtk.Entry({
              placeholder_text: _("wm_class, e.g. firefox"),
              hexpand: true,
            });
            const errLabel = new Gtk.Label({
              css_classes: ["error"],
              visible: false,
              halign: Gtk.Align.START,
              wrap: true,
            });
            const applyBtn = new Gtk.Button({ label: _("Add") });
            applyBtn.connect("clicked", () => {
              const v = entry.text.trim().toLowerCase();
              if (!v) {
                errLabel.label = _("Enter a value first.");
                errLabel.visible = true;
                return;
              }
              const arr = profile.conditions["wm-class"] ?? [];
              if (!arr.includes(v)) arr.push(v);
              profile.conditions["wm-class"] = arr;
              rebuildChips();
              updateSpec();
              save();
              entry.text = "";
              errLabel.visible = false;
              addBtn.popdown();
            });
            box.append(entry);
            box.append(errLabel);
            box.append(applyBtn);

            // 建议列表：扩展记录的最近 wm_class
            try {
              const seen = JSON.parse(
                settings.get_string("seen-wm-classes") || "[]",
              );
              if (Array.isArray(seen) && seen.length > 0) {
                const flow = new Gtk.Box({ spacing: 4 });
                for (const s of seen.slice(-12)) {
                  if (typeof s !== "string") continue;
                  const b = new Gtk.Button({
                    label: s,
                    css_classes: ["chip"],
                  });
                  b.connect("clicked", () => {
                    entry.text = s;
                  });
                  flow.append(b);
                }
                box.append(new Gtk.Label({
                  label: _("Recently seen:"),
                  halign: Gtk.Align.START,
                  css_classes: ["dim-label", "caption"],
                }));
                box.append(flow);
              }
            } catch {
              // 建议列表解析失败不影响主流程
            }

            addBtn.popover = new Gtk.Popover({ child: box, autohide: true });
          }

          rebuildChips();
          row.add_suffix(chipsBox);
          row.add_suffix(addBtn);
          condGroup.add(row);
        }

        updateSpec();
      }

      // —— 设置补丁组：每行一个开关，未设置时展示继承值 ——
      const settingsGroup = new Adw.PreferencesGroup({
        title: _("Trail Settings"),
        description: _(
          "Switched-off rows are unset and inherit from lower-priority rules.",
        ),
      });
      epage.add(settingsGroup);

      const rainbowRowState = { refresh: null };

      // opts: {
      //   changedSignal: 控件的变更信号
      //   getValue(): 控件 → 值（undefined 表示当前无有效值）
      //   setValue(v): 值 → 控件
      //   afterChange(): 值写入后的钩子（如刷新彩虹行）
      // }
      // 开启开关时采用继承值作为初始值，避免视觉跳变。
      const makeSettingRow = (key, title, control, opts) => {
        const row = new Adw.ActionRow({ title, subtitle: "" });
        const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        let suppress = false;

        const refresh = () => {
          const set = key in profile.settings;
          suppress = true;
          sw.active = set;
          control.sensitive = set;
          if (set) opts.setValue(profile.settings[key]);
          suppress = false;
          row.subtitle = set
            ? ""
            : `${_("Inherits")}: ${fmtValue(key, inheritedFor(key))}`;
        };

        sw.connect("notify::active", () => {
          if (suppress) return;
          if (sw.active) {
            profile.settings[key] = inheritedFor(key);
            suppress = true;
            opts.setValue(profile.settings[key]);
            suppress = false;
          } else {
            delete profile.settings[key];
          }
          refresh();
          save();
          rainbowRowState.refresh?.();
        });

        control.connect(opts.changedSignal, () => {
          if (suppress || !(key in profile.settings)) return;
          const v = opts.getValue();
          if (v === undefined) return;
          profile.settings[key] = v;
          save();
          opts.afterChange?.();
        });

        row.add_suffix(control);
        row.add_suffix(sw);
        settingsGroup.add(row);
        refresh();
        return row;
      };

      // 淡出时长
      {
        const control = new Gtk.SpinButton({
          valign: Gtk.Align.CENTER,
          adjustment: new Gtk.Adjustment({
            lower: 50,
            upper: 2000,
            step_increment: 50,
            page_increment: 100,
          }),
        });
        makeSettingRow("fade-duration", _("Fade Duration"), control, {
          changedSignal: "value-changed",
          getValue: () => control.get_value(),
          setValue: (v) => control.set_value(v),
        });
      }

      // 线条宽度
      {
        const control = new Gtk.SpinButton({
          valign: Gtk.Align.CENTER,
          adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 20,
            step_increment: 1,
            page_increment: 2,
          }),
        });
        makeSettingRow("line-width", _("Line Width"), control, {
          changedSignal: "value-changed",
          getValue: () => control.get_value(),
          setValue: (v) => control.set_value(v),
        });
      }

      // 渲染模式
      {
        const KEYS = ["precise", "balance", "fast"];
        const control = new Gtk.DropDown({
          model: stringList(KEYS.map((k) => RENDER_LABELS[k])),
          valign: Gtk.Align.CENTER,
        });
        makeSettingRow("render-mode", _("Render Mode"), control, {
          changedSignal: "notify::selected",
          getValue: () => KEYS[control.selected],
          setValue: (v) => {
            control.selected = Math.max(0, KEYS.indexOf(v));
          },
        });
      }

      // 颜色模式
      {
        const KEYS = [
          "solid",
          "rainbow-fixed",
          "rainbow-ratio",
          "rainbow-time",
        ];
        const control = new Gtk.DropDown({
          model: stringList(KEYS.map((k) => COLOR_MODE_LABELS[k])),
          valign: Gtk.Align.CENTER,
        });
        makeSettingRow("color-mode", _("Color Mode"), control, {
          changedSignal: "notify::selected",
          getValue: () => KEYS[control.selected],
          setValue: (v) => {
            control.selected = Math.max(0, KEYS.indexOf(v));
          },
          afterChange: () => rainbowRowState.refresh?.(),
        });
      }

      // 轨迹颜色
      {
        const control = new Gtk.ColorButton({ valign: Gtk.Align.CENTER });
        makeSettingRow("color", _("Trail Color"), control, {
          changedSignal: "color-set",
          getValue: () => {
            const rgba = control.get_rgba();
            return [rgba.red, rgba.green, rgba.blue];
          },
          setValue: (v) => {
            const rgba = new Gdk.RGBA();
            rgba.red = v[0];
            rgba.green = v[1];
            rgba.blue = v[2];
            rgba.alpha = 1;
            control.set_rgba(rgba);
          },
        });
      }

      // 透明度
      {
        const control = new Gtk.Scale({
          valign: Gtk.Align.CENTER,
          width_request: 140,
          draw_value: true,
          digits: 2,
          adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 1,
            step_increment: 0.01,
            page_increment: 0.1,
          }),
        });
        makeSettingRow("alpha", _("Trail Transparency"), control, {
          changedSignal: "value-changed",
          getValue: () => control.get_value(),
          setValue: (v) => control.set_value(v),
        });
      }

      // 彩虹配置：单入口，编辑"本规则颜色模式（未设置则继承）"对应的 config 键
      {
        const row = new Adw.ActionRow({
          title: _("Rainbow Configuration"),
          subtitle: "",
        });
        const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        const editBtn = new Gtk.Button({
          label: _("Edit…"),
          valign: Gtk.Align.CENTER,
        });

        const targetKey = () => {
          const mode =
            profile.settings["color-mode"] ?? inheritedFor("color-mode");
          return mode === "solid"
            ? null
            : `rainbow-${mode.replace("rainbow-", "")}-config`;
        };

        const refresh = () => {
          const key = targetKey();
          if (!key) {
            sw.sensitive = false;
            sw.active = false;
            editBtn.sensitive = false;
            row.subtitle = _("Requires a rainbow color mode");
            return;
          }
          sw.sensitive = true;
          const set = key in profile.settings;
          sw.active = set;
          editBtn.sensitive = set;
          row.subtitle = set
            ? ""
            : `${_("Inherits")}: ${fmtValue(key, inheritedFor(key))}`;
        };

        sw.connect("notify::active", () => {
          const key = targetKey();
          if (!key) return;
          if (sw.active) {
            profile.settings[key] = inheritedFor(key);
          } else {
            delete profile.settings[key];
          }
          refresh();
          save();
        });

        editBtn.connect("clicked", () => {
          const key = targetKey();
          if (!key || !(key in profile.settings)) return;
          openRainbowDialog(
            key,
            profile.settings[key],
            (text) => {
              profile.settings[key] = text;
              save();
            },
            dialog,
          );
        });

        rainbowRowState.row = row;
        rainbowRowState.refresh = refresh;

        row.add_suffix(editBtn);
        row.add_suffix(sw);
        settingsGroup.add(row);
        refresh();
      }

      // —— 危险组（行尾红色按钮，与主页面重置一致）——
      if (!isDefault) {
        const dangerGroup = new Adw.PreferencesGroup();
        epage.add(dangerGroup);
        const delRow = new Adw.ActionRow({
          title: _("Delete Profile"),
          subtitle: _("Remove this profile permanently"),
        });
        const delButton = new Gtk.Button({
          label: _("Delete"),
          valign: Gtk.Align.CENTER,
          css_classes: ["destructive-action"],
        });
        delButton.connect("clicked", () => {
          confirmDestructive(
            dialog,
            _("Delete Profile?"),
            _("This profile and its conditions will be removed."),
            _("Delete"),
            () => {
              profiles.splice(idx, 1);
              save();
              dialog.close();
              window.add_toast(
                new Adw.Toast({ title: _("Profile deleted") }),
              );
            },
          );
        });
        delRow.add_suffix(delButton);
        dangerGroup.add(delRow);
      }

      dialog.present(window);
    }

    // 彩虹配置编辑对话框（Adw.Dialog + TextView + 校验）
    // parentWidget：父级对话框（从编辑器内打开时）或 prefs 窗口
    function openRainbowDialog(configKey, text, onSaved, parentWidget) {
      const mode = configKey.startsWith("rainbow-")
        ? configKey.replace("-config", "")
        : "solid";
      const dialog = new Adw.Dialog({
        title: _("Rainbow Configuration"),
        content_width: 460,
        content_height: 380,
      });

      const header = new Adw.HeaderBar();
      const saveBtn = new Gtk.Button({
        label: _("Save"),
        css_classes: ["suggested-action"],
      });
      header.pack_end(saveBtn);
      saveBtn.connect("clicked", () => {
        const buf = textView.get_buffer();
        const newText = buf.text;
        const error = validateRainbowText(mode, newText);
        if (error) {
          errLabel.label = error;
          errLabel.visible = true;
          return;
        }
        onSaved(newText);
        dialog.close();
      });

      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
      });

      const hint = new Gtk.Label({
        label: rainbowHint(mode),
        wrap: true,
        xalign: 0,
        css_classes: ["caption", "dim-label"],
      });
      const textView = new Gtk.TextView({
        monospace: true,
        top_margin: 8,
        bottom_margin: 8,
        left_margin: 8,
        right_margin: 8,
        vexpand: true,
      });
      textView.get_buffer().set_text(text, -1);
      const scrolled = new Gtk.ScrolledWindow({
        child: textView,
        vexpand: true,
        has_frame: true,
        min_content_height: 200,
      });
      const errLabel = new Gtk.Label({
        css_classes: ["error"],
        visible: false,
        wrap: true,
        xalign: 0,
      });

      box.append(hint);
      box.append(scrolled);
      box.append(errLabel);

      const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
      });
      content.append(header);
      content.append(box);
      dialog.set_child(content);
      dialog.present(parentWidget ?? window);
    }

    rebuildList();
  }
}
