import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import GObject from "gi://GObject";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
  BUILTIN_STYLES,
  readStyleState,
  effectiveFor,
  stateMatches,
  setDefaultValue,
  setDarkValue,
  ensureStyleMigrated,
  parseRainbowStops,
  timeColorAt,
  validateRainbowText,
} from "./styleEngine.js";

import {
  drawTrailPreview,
  calculatePointColors,
  synthPreviewTrail,
} from "./trailRender.js";

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

// 一次性注入卡片/预览样式
let cssAdded = false;
function ensureCss() {
  if (cssAdded) return;
  cssAdded = true;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(
    ".mt-card { border: 2px solid transparent; border-radius: 12px; padding: 6px; } " +
      ".mt-card.mt-selected { border-color: @accent_color; } " +
      ".mt-customize { border-radius: 9999px; padding: 10px 28px; " +
      "background: alpha(@window_fg_color, 0.08); color: @window_fg_color; " +
      "font-weight: 700; } " +
      ".mt-customize:hover { background: alpha(@window_fg_color, 0.15); } " +
      ".mt-tag-light { color: rgba(0, 0, 0, 0.45); } " +
      ".mt-tag-dark { color: rgba(255, 255, 255, 0.55); }",
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

// 逐角圆角矩形路径：rTop/rBottom 分别为上/下角半径（0 为直角）
function roundedRectPath(cr, x, y, w, h, rTop, rBottom) {
  const t = Math.min(rTop, h / 2, w / 2);
  const b = Math.min(rBottom, h / 2, w / 2);
  cr.newPath();
  cr.moveTo(x, y + t);
  cr.arc(x + t, y + t, t, Math.PI, 1.5 * Math.PI);
  cr.lineTo(x + w - t, y);
  cr.arc(x + w - t, y + t, t, -0.5 * Math.PI, 0);
  cr.lineTo(x + w, y + h - b);
  cr.arc(x + w - b, y + h - b, b, 0, 0.5 * Math.PI);
  cr.lineTo(x + b, y + h);
  cr.arc(x + b, y + h - b, b, 0.5 * Math.PI, Math.PI);
  cr.closePath();
}

// —— 样式预览：上半白底展示浅色效果，下半黑底展示暗色效果 ——
const StylePreview = GObject.registerClass(
  class StylePreview extends Gtk.DrawingArea {
    _init({ height = 96 } = {}) {
      super._init({
        height_request: height,
        hexpand: true,
      });
      this._style = null;
      this.set_draw_func((da, cr, w, h) => this._draw(cr, w, h));
    }

    setStyle(style) {
      this._style = style;
      this.queue_draw();
    }

    _drawHalf(cr, w, h0, y0, bg, eff) {
      cr.save();
      // 上半圆角在上、下半圆角在下，中缝保持平直
      roundedRectPath(
        cr,
        0,
        y0,
        w,
        h0,
        y0 === 0 ? 8 : 0,
        y0 === 0 ? 0 : 8,
      );
      cr.clip();
      cr.setSourceRGB(bg[0], bg[1], bg[2]);
      cr.paint();

      const mode = eff["color-mode"];
      let parsed = null;
      if (mode !== "solid") {
        parsed = parseRainbowStops(
          mode,
          eff[`rainbow-${mode.replace("rainbow-", "")}-config`],
        );
      }

      // 合成一条"真实轨迹"快照（见 synthPreviewTrail）：固定 12 段标准
      // sin 单周期，渐隐包络按 fadeDuration/3 时间窗取样，观感统一
      const size = eff["line-width"];
      const { pts: base, now } = synthPreviewTrail(
        w,
        h0,
        y0,
        size,
        eff["fade-duration"],
        eff.alpha,
      );
      let pts = base;
      if (mode === "rainbow-time") {
        // 颜色沿整个彩虹周期扫过（展示完整循环），与渐隐包络时间轴解耦
        const period = parsed?.period ?? 1;
        pts = base.map((p, i) => {
          const [rr, gg, bb] = timeColorAt(
            parsed,
            (i / (base.length - 1)) * period,
          );
          return [p[0], p[1], p[2], rr, gg, bb];
        });
      }

      let pointColors = null;
      if (mode === "rainbow-fixed" || mode === "rainbow-ratio") {
        pointColors = calculatePointColors(pts, mode, parsed);
      }

      drawTrailPreview(cr, pts, {
        size,
        fadeLength: eff["fade-duration"],
        colorMode: mode,
        color: eff.color,
        alpha: eff.alpha,
        now,
        pointColors,
      });
      cr.restore();
    }

    _draw(cr, w, h) {
      if (!this._style) return;
      const light = effectiveFor(this._style, false);
      const dark = effectiveFor(this._style, true);
      this._drawHalf(cr, w, h / 2, 0, [1, 1, 1], light);
      this._drawHalf(cr, w, h / 2, h / 2, [0, 0, 0], dark);
    }
  },
);

export default class MouseTailPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    ensureCss();
    const settings = this.getSettings(
      "org.gnome.shell.extensions.mouse-tail",
    );
    ensureStyleMigrated(settings);

    // 仅供展示的枚举名。gettext 只能在扩展上下文就绪后调用，
    // 因此这些映射必须留在 fillPreferencesWindow 内部
    const COLOR_MODE_LABELS = {
      solid: _("Solid"),
      "rainbow-fixed": _("Fixed-length rainbow"),
      "rainbow-ratio": _("Ratio rainbow"),
      "rainbow-time": _("Time-based rainbow"),
    };
    const getState = () => readStyleState(settings);

    // 原子地修改样式状态并写回
    const writeState = (mut) => {
      const st = getState();
      mut(st);
      settings.set_string("style-defaults", JSON.stringify(st.defaults));
      settings.set_string("style-dark-overrides", JSON.stringify(st.dark));
    };
    const applyStyle = (style) => {
      settings.set_string("style-defaults", JSON.stringify(style.defaults));
      settings.set_string(
        "style-dark-overrides",
        JSON.stringify(style.dark),
      );
    };

    // ———————————— 主页面：样式选择 ————————————

    const page = new Adw.PreferencesPage({
      title: _("Style"),
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    const styleGroup = new Adw.PreferencesGroup({
      title: _("Style"),
      description: _(
        "Pick a style. Each preview shows the trail on light and dark backgrounds.",
      ),
    });
    page.add(styleGroup);

    const cardGrid = new Gtk.Grid({
      column_homogeneous: true,
      column_spacing: 12,
      row_spacing: 12,
      margin_top: 6,
      hexpand: true,
    });
    styleGroup.add(cardGrid);

    const PRESET_LABELS = {
      basic: _("Basic"),
      spark: _("Spark"),
      aurora: _("Aurora"),
    };

    function makeCard(style, selected, label, onActivate) {
      const preview = new StylePreview({ height: 116 });
      preview.setStyle(style);

      const name = new Gtk.Label({
        label,
        css_classes: ["heading"],
      });
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
      });
      box.append(preview);
      box.append(name);

      const button = new Gtk.Button({
        child: box,
        css_classes: ["mt-card", "flat"],
        hexpand: true,
      });
      if (selected) button.add_css_class("mt-selected");
      button.connect("clicked", onActivate);
      return button;
    }

    let cardWidgets = [];

    function rebuildCards() {
      for (const card of cardWidgets) cardGrid.remove(card);
      cardWidgets = [];

      const current = getState();
      const matched = BUILTIN_STYLES.find((preset) =>
        stateMatches(current, preset),
      );
      const entries = BUILTIN_STYLES.map((preset) => ({
        style: preset,
        label: PRESET_LABELS[preset.id],
        selected: preset === matched,
      }));
      // 当前样式不属于任何预设（如自定义调整后）：追加自定义卡片
      if (!matched) entries.push({ style: current, label: _("Custom"), selected: true });

      // 两列布局，随页面宽度弹性伸展
      entries.forEach((entry, i) => {
        const style = entry.style;
        const card = makeCard(style, entry.selected, entry.label, () =>
          applyStyle(style),
        );
        cardGrid.attach(card, i % 2, Math.floor(i / 2), 1, 1);
        cardWidgets.push(card);
      });
    }

    // 编辑对话框（本进程）或其他来源写入时刷新选中态
    for (const key of ["style-defaults", "style-dark-overrides"]) {
      settings.connect(`changed::${key}`, rebuildCards);
    }

    // 自定义按钮：占据卡片下方的剩余空间，居中其中；margin_top 保证
    // 空间不足（滚动状态）时与卡片网格仍有固定间距
    styleGroup.vexpand = true;
    const customizeWrap = new Gtk.Box({
      vexpand: true,
      hexpand: true,
      margin_top: 14,
    });
    const customizeBtn = new Gtk.Button({
      label: _("Customize…"),
      css_classes: ["mt-customize"],
      hexpand: true, // GTK4 中 halign 需配合 hexpand（过大分配）才会居中
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
    });
    customizeBtn.connect("clicked", () => openStyleEditor());
    customizeWrap.append(customizeBtn);
    styleGroup.add(customizeWrap);

    // ———————————— 样式设置对话框 ————————————

    function openStyleEditor() {
      const dialog = new Adw.Dialog({
        title: _("Customize Style"),
        content_width: 560,
        content_height: 680,
      });
      const epage = new Adw.PreferencesPage({ vexpand: true });
      const dialogBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
      });
      dialogBox.append(new Adw.HeaderBar());
      dialogBox.append(epage);
      dialog.set_child(dialogBox);

      let mode = "default"; // "default" | "dark"

      // 顶部预览：同步显示当前样式在浅色/暗色下的效果
      const previewGroup = new Adw.PreferencesGroup();
      epage.add(previewGroup);
      const preview = new StylePreview({ height: 130 });
      const previewOverlay = new Gtk.Overlay({ child: preview });
      const tagLight = new Gtk.Label({
        label: _("Light"),
        css_classes: ["caption", "mt-tag-light"],
        halign: Gtk.Align.START,
        valign: Gtk.Align.START,
        margin_start: 8,
        margin_top: 4,
      });
      const tagDark = new Gtk.Label({
        label: _("Dark"),
        css_classes: ["caption", "mt-tag-dark"],
        halign: Gtk.Align.START,
        valign: Gtk.Align.END,
        margin_start: 8,
        margin_bottom: 4,
      });
      previewOverlay.add_overlay(tagLight);
      previewOverlay.add_overlay(tagDark);
      previewGroup.add(previewOverlay);

      // 模式切换：居中的 Default/Dark 按钮组（无外框、无说明文字）
      const btnDefault = new Gtk.ToggleButton({ label: _("Default") });
      const btnDark = new Gtk.ToggleButton({ label: _("Dark") });
      btnDefault.bind_property(
        "active",
        btnDark,
        "active",
        GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.INVERT_BOOLEAN,
      );
      btnDefault.active = true;
      const setMode = (m) => {
        mode = m;
        btnDefault.active = m === "default";
        refreshAll();
      };
      btnDefault.connect("toggled", () => {
        if (btnDefault.active && mode !== "default") setMode("default");
      });
      btnDark.connect("toggled", () => {
        if (btnDark.active && mode !== "dark") setMode("dark");
      });
      const modeBox = new Gtk.Box({
        css_classes: ["linked"],
        halign: Gtk.Align.CENTER,
        margin_top: 12,
        margin_bottom: 0,
      });
      modeBox.append(btnDefault);
      modeBox.append(btnDark);
      previewGroup.add(modeBox);

      // 设置项：默认状态下为普通控件；暗色模式下追加"撤销覆盖"按钮
      const settingsGroup = new Adw.PreferencesGroup();
      epage.add(settingsGroup);

      const rowsRefreshers = [];

      // 当前编辑模式下某键的显示值
      const displayValue = (key) =>
        effectiveFor(getState(), mode === "dark")[key];

      const makeSettingRow = (key, title, subtitle, control, opts) => {
        const row = new Adw.ActionRow({ title, subtitle });
        const revertBtn = new Gtk.Button({
          icon_name: "edit-undo-symbolic",
          valign: Gtk.Align.CENTER,
          css_classes: ["flat", "circular"],
          tooltip_text: _("Stop overriding in dark state"),
        });
        revertBtn.connect("clicked", () => {
          writeState((st) => {
            delete st.dark[key];
          });
          refreshAll();
        });

        let suppress = false;
        control.connect(opts.changedSignal, () => {
          if (suppress) return;
          const v = opts.getValue();
          if (v === undefined) return;
          writeState((st) => {
            if (mode === "default") setDefaultValue(st, key, v);
            else setDarkValue(st, key, v);
          });
          refreshAll();
        });

        const refresh = () => {
          suppress = true;
          opts.setValue(displayValue(key));
          suppress = false;
          revertBtn.visible = mode === "dark";
          revertBtn.sensitive = key in getState().dark;
        };

        row.add_suffix(control);
        row.add_suffix(revertBtn);
        settingsGroup.add(row);
        rowsRefreshers.push(refresh);
        refresh();
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
        makeSettingRow(
          "fade-duration",
          _("Fade Duration"),
          _("How long the trail takes to fade out (milliseconds)"),
          control,
          {
            changedSignal: "value-changed",
            getValue: () => control.get_value(),
            setValue: (v) => control.set_value(v),
          },
        );
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
        makeSettingRow(
          "line-width",
          _("Line Width"),
          _("Thickness of the mouse trail line"),
          control,
          {
            changedSignal: "value-changed",
            getValue: () => control.get_value(),
            setValue: (v) => control.set_value(v),
          },
        );
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
        makeSettingRow(
          "color-mode",
          _("Color Mode"),
          _("Choose a color mode for the mouse trail"),
          control,
          {
            changedSignal: "notify::selected",
            getValue: () => KEYS[control.selected],
            setValue: (v) => {
              control.selected = Math.max(0, KEYS.indexOf(v));
            },
          },
        );
      }

      // 轨迹颜色
      {
        const control = new Gtk.ColorButton({ valign: Gtk.Align.CENTER });
        makeSettingRow(
          "color",
          _("Trail Color"),
          _("Color of the mouse trail"),
          control,
          {
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
          },
        );
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
        makeSettingRow(
          "alpha",
          _("Trail Transparency"),
          _("Opacity level of the mouse trail"),
          control,
          {
            changedSignal: "value-changed",
            getValue: () => control.get_value(),
            setValue: (v) => control.set_value(v),
          },
        );
      }

      // 彩虹配置：编辑"当前编辑模式下颜色模式"对应的 config 键
      {
        const row = new Adw.ActionRow({
          title: _("Rainbow Configuration"),
          subtitle: _("Color stops used by rainbow color modes"),
        });
        const editBtn = new Gtk.Button({
          label: _("Edit…"),
          valign: Gtk.Align.CENTER,
        });
        const revertBtn = new Gtk.Button({
          icon_name: "edit-undo-symbolic",
          valign: Gtk.Align.CENTER,
          css_classes: ["flat", "circular"],
          tooltip_text: _("Stop overriding in dark state"),
        });

        const targetKey = () => {
          const m = displayValue("color-mode");
          return m === "solid"
            ? null
            : `rainbow-${m.replace("rainbow-", "")}-config`;
        };

        revertBtn.connect("clicked", () => {
          const key = targetKey();
          if (!key) return;
          writeState((st) => {
            delete st.dark[key];
          });
          refreshAll();
        });
        editBtn.connect("clicked", () => {
          const key = targetKey();
          if (!key) return;
          const st = getState();
          const current =
            (mode === "dark" ? st.dark[key] : undefined) ??
            effectiveFor(st, false)[key];
          openRainbowDialog(
            key,
            current,
            (text) => {
              writeState((st2) => {
                if (mode === "default") setDefaultValue(st2, key, text);
                else setDarkValue(st2, key, text);
              });
              refreshAll();
            },
            dialog,
          );
        });

        const refresh = () => {
          const key = targetKey();
          const st = getState();
          editBtn.sensitive = key !== null;
          editBtn.tooltip_text = key
            ? null
            : _("Requires a rainbow color mode");
          revertBtn.visible = mode === "dark";
          revertBtn.sensitive = key !== null && key in st.dark;
        };

        row.add_suffix(editBtn);
        row.add_suffix(revertBtn);
        settingsGroup.add(row);
        rowsRefreshers.push(refresh);
        refresh();
      }

      const refreshAll = () => {
        preview.setStyle(getState());
        for (const refresh of rowsRefreshers) refresh();
      };
      refreshAll();

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

      saveBtn.connect("clicked", () => {
        const newText = textView.get_buffer().text;
        const error = validateRainbowText(mode, newText);
        if (error) {
          errLabel.label = error;
          errLabel.visible = true;
          return;
        }
        onSaved(newText);
        dialog.close();
      });
      header.pack_end(saveBtn);

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

    rebuildCards();
  }
}
