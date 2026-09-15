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
  readCustomStyles,
  saveCustomStyle,
  removeCustomStyle,
  genId,
  effectiveFor,
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

// Rainbow config format hints. gettext can only be called at runtime, so
// these live in a function instead of module-level constants
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

// Inject card/preview CSS once
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

// Per-corner rounded-rect path: rTop/rBottom are the top/bottom corner
// radii (0 = square corner)
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

// -- Style preview: top half on white shows the light-style look, bottom
// half on black shows the dark-style look --
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
      // Rounded corners on top for the upper half, on the bottom for the
      // lower half; the center seam stays straight
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

      // Synthesize a "real trail" snapshot (see synthPreviewTrail): a fixed
      // 12-segment standard sine period, with the fade envelope sampled
      // over a fadeDuration/3 time window for a consistent look
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
        // Sweep colors across the whole rainbow period (showing one full
        // cycle), decoupled from the fade envelope's time axis
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

    // Display-only enum names. gettext can only be called once the
    // extension context is ready, so these maps must stay inside
    // fillPreferencesWindow
    const COLOR_MODE_LABELS = {
      solid: _("Solid"),
      "rainbow-fixed": _("Fixed-length rainbow"),
      "rainbow-ratio": _("Ratio rainbow"),
      "rainbow-time": _("Time-based rainbow"),
    };
    const getState = () => readStyleState(settings);
    const activeId = () => settings.get_string("active-style");

    // Activate a style: write its patches and mark it selected by id
    const applyStyle = (id, style) => {
      settings.set_string("style-defaults", JSON.stringify(style.defaults));
      settings.set_string(
        "style-dark-overrides",
        JSON.stringify(style.dark),
      );
      settings.set_string("active-style", id);
    };

    // Mutate the active style state and write it back atomically. The
    // editor only ever edits an active custom style, so every edit is
    // persisted into its stored entry as well
    const writeState = (mut) => {
      const st = getState();
      mut(st);
      settings.set_string("style-defaults", JSON.stringify(st.defaults));
      settings.set_string("style-dark-overrides", JSON.stringify(st.dark));
      saveCustomStyle(settings, { id: activeId(), ...st });
    };

    // ----- Main page: style picker -----

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

      // Selection is id-based: preset ids plus stored custom style ids
      const active = activeId();
      const entries = BUILTIN_STYLES.map((preset) => ({
        id: preset.id,
        style: preset,
        label: PRESET_LABELS[preset.id],
        selected: preset.id === active,
      }));
      readCustomStyles(settings).forEach((style, i) => {
        entries.push({
          id: style.id,
          style,
          label: `${_("Custom")} ${i + 1}`,
          selected: style.id === active,
        });
      });

      // Two-column layout, stretching with the page width
      entries.forEach((entry, i) => {
        const card = makeCard(entry.style, entry.selected, entry.label, () =>
          applyStyle(entry.id, entry.style),
        );
        cardGrid.attach(card, i % 2, Math.floor(i / 2), 1, 1);
        cardWidgets.push(card);
      });
    }

    // The card list and selection depend only on the style ids, not on the
    // live patch values
    for (const key of ["active-style", "custom-styles"]) {
      settings.connect(`changed::${key}`, rebuildCards);
    }

    // Customize button: fills the leftover space below the cards and sits
    // centered in it; margin_top keeps a fixed gap from the card grid even
    // when space runs out (scrolled state)
    styleGroup.vexpand = true;
    const customizeWrap = new Gtk.Box({
      vexpand: true,
      hexpand: true,
      margin_top: 14,
    });
    const customizeBtn = new Gtk.Button({
      label: _("Customize…"),
      css_classes: ["mt-customize"],
      hexpand: true, // In GTK4, halign only centers when the child gets an oversized allocation, hence hexpand
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
    });
    customizeBtn.connect("clicked", () => openStyleEditor());
    customizeWrap.append(customizeBtn);
    styleGroup.add(customizeWrap);

    // ----- Style editor subpage (not a dialog; pushed on the navigation stack) -----

    function openStyleEditor() {
      // The editor edits custom styles only: when a preset is active,
      // Customize derives a new custom style from it (editing further
      // customizes that entry in place)
      const id = activeId();
      let editing = readCustomStyles(settings).find((s) => s.id === id);
      if (!editing) {
        editing = { id: genId(), ...getState() };
        saveCustomStyle(settings, editing);
        applyStyle(editing.id, editing);
      }

      // Subpage container: ToolbarView (the navigation stack provides the
      // title and back button automatically)
      const toolbar = new Adw.ToolbarView();
      toolbar.add_top_bar(new Adw.HeaderBar());

      const epage = new Adw.PreferencesPage({ vexpand: true });
      toolbar.set_content(epage);

      let mode = "default"; // "default" | "dark"

      // Top preview: shows the current style on light and dark backgrounds
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

      // Mode switch: centered Default/Dark button group (no frame, no caption)
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

      // Settings rows: plain controls in default mode; in dark mode each
      // row gains a "revert override" button
      const settingsGroup = new Adw.PreferencesGroup();
      epage.add(settingsGroup);

      const rowsRefreshers = [];

      // Displayed value of a key under the currently edited mode
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

      // Fade duration
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

      // Line width
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

      // Color mode
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

      // Trail color
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

      // Transparency
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

      // Rainbow config: edits the config key matching the color mode of the
      // currently edited mode
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
            window,
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

      // Delete this custom style (the active one by construction) and fall
      // back to the first preset
      const deleteBtn = new Gtk.Button({
        label: _("Delete Style"),
        css_classes: ["destructive-action", "pill"],
        halign: Gtk.Align.CENTER,
        margin_top: 12,
        margin_bottom: 12,
      });
      deleteBtn.connect("clicked", () => {
        const dialog = new Adw.MessageDialog({
          heading: _("Delete Style"),
          body: _("This custom style will be removed."),
        });
        dialog.add_response("cancel", _("Cancel"));
        dialog.add_response("delete", _("Delete"));
        dialog.set_response_appearance(
          "delete",
          Adw.ResponseAppearance.DESTRUCTIVE,
        );
        dialog.connect("response", (dlg, response) => {
          dlg.close();
          if (response !== "delete") return;
          removeCustomStyle(settings, editing.id);
          if (activeId() === editing.id)
            applyStyle(BUILTIN_STYLES[0].id, BUILTIN_STYLES[0]);
          window.pop_subpage();
        });
        dialog.present(window);
      });
      const deleteGroup = new Adw.PreferencesGroup();
      deleteGroup.add(deleteBtn);
      epage.add(deleteGroup);

      // Push onto the PreferencesWindow navigation stack (subpage, not a
      // dialog; title and back button come for free)
      const navPage = new Adw.NavigationPage({
        child: toolbar,
        title: _("Customize Style"),
      });
      window.push_subpage(navPage);
    }

    // Rainbow config editor dialog (Adw.Dialog + TextView + validation)
    // parentWidget: the hosting window (still the prefs window when opened
    // from inside the editor subpage)
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
