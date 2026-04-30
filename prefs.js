import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import GLib from "gi://GLib";
import GObject from "gi://GObject";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class MouseTailPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const page = new Adw.PreferencesPage({
      title: _("General"),
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    const group = new Adw.PreferencesGroup({
      title: _("Mouse Tail Settings"),
      description: _("Configure the appearance of the mouse tail effect"),
    });
    page.add(group);

    const settings = this.getSettings("org.gnome.shell.extensions.mouse-tail");

    // Fade Duration
    const fadeDurationRow = new Adw.SpinRow({
      title: _("Fade Duration"),
      subtitle: _("How long the trail takes to fade out (milliseconds)"),
      adjustment: new Gtk.Adjustment({
        lower: 50,
        upper: 2000,
        step_increment: 50,
        page_increment: 100,
      }),
    });
    fadeDurationRow.set_value(settings.get_int("fade-duration"));
    fadeDurationRow.connect("notify::value", () => {
      settings.set_int("fade-duration", fadeDurationRow.get_value());
    });
    group.add(fadeDurationRow);

    // Line Width
    const lineWidthRow = new Adw.SpinRow({
      title: _("Line Width"),
      subtitle: _("Thickness of the mouse trail line"),
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 20,
        step_increment: 1,
        page_increment: 2,
      }),
    });
    lineWidthRow.set_value(settings.get_int("line-width"));
    lineWidthRow.connect("notify::value", () => {
      settings.set_int("line-width", lineWidthRow.get_value());
    });
    group.add(lineWidthRow);

    // Render Mode
    const renderModeRow = new Adw.ComboRow({
      title: _("Render Mode"),
      subtitle: _("Choose between precise smooth curves or fast simple lines"),
    });
    const renderModeModel = new Gtk.StringList();
    renderModeModel.append(_("Precise"));
    renderModeModel.append(_("Balance"));
    renderModeModel.append(_("Fast"));
    renderModeRow.set_model(renderModeModel);
    {
      const mode = settings.get_string("render-mode");
      renderModeRow.set_selected(
        mode === "balance" ? 1 : mode === "fast" ? 2 : 0
      );
    }
    renderModeRow.connect("notify::selected", () => {
      const idx = renderModeRow.get_selected();
      settings.set_string("render-mode", idx === 1 ? "balance" : idx === 2 ? "fast" : "precise");
    });
    group.add(renderModeRow);

    // Color Mode
    const colorModeRow = new Adw.ComboRow({
      title: _("Color Mode"),
      subtitle: _("Choose a color mode for the mouse trail"),
    });
    const colorModeModel = new Gtk.StringList();
    colorModeModel.append(_("Solid"));
    colorModeModel.append(_("Fixed-Length Rainbow"));
    colorModeModel.append(_("Ratio Rainbow"));
    colorModeModel.append(_("Time-Based Rainbow"));
    colorModeRow.set_model(colorModeModel);
    {
      const mode = settings.get_string("color-mode");
      const idx = ["solid", "rainbow-fixed", "rainbow-ratio", "rainbow-time"].indexOf(mode);
      colorModeRow.set_selected(idx >= 0 ? idx : 0);
    }
    group.add(colorModeRow);

    // Solid color controls
    const colorRow = new Adw.ActionRow({
      title: _("Trail Color"),
      subtitle: _("Color of the mouse trail"),
    });
    const colorButton = new Gtk.ColorButton({
      valign: Gtk.Align.CENTER,
      use_alpha: false,
      rgba: this._arrayToRgba(settings.get_value("color").deep_unpack()),
    });
    colorButton.connect("color-set", () => {
      const rgba = colorButton.get_rgba();
      settings.set_value("color", new GLib.Variant("ad", [rgba.red, rgba.green, rgba.blue]));
    });
    colorRow.add_suffix(colorButton);
    group.add(colorRow);

    const alphaRow = new Adw.ActionRow({
      title: _("Trail Transparency"),
      subtitle: _("Opacity level of the mouse trail"),
    });
    const alphaScale = new Gtk.Scale({
      orientation: Gtk.Orientation.HORIZONTAL,
      valign: Gtk.Align.CENTER,
      hexpand: true,
      width_request: 200,
      adjustment: new Gtk.Adjustment({
        lower: 0.0,
        upper: 1.0,
        step_increment: 0.01,
        page_increment: 0.1,
      }),
    });
    alphaScale.set_digits(2);
    alphaScale.set_value(settings.get_double("alpha"));
    alphaScale.connect("value-changed", () => {
      settings.set_double("alpha", alphaScale.get_value());
    });
    alphaRow.add_suffix(alphaScale);
    group.add(alphaRow);

    // Rainbow configuration container
    const rainbowBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8,
      margin_top: 8,
      margin_bottom: 8,
      margin_start: 12,
      margin_end: 12,
    });

    const rainbowDescLabel = new Gtk.Label({
      wrap: true,
      xalign: 0,
      css_classes: ["caption"],
    });
    rainbowBox.append(rainbowDescLabel);

    const rainbowTextView = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.NONE,
      monospace: true,
      top_margin: 8,
      bottom_margin: 8,
      left_margin: 8,
      right_margin: 8,
    });
    const scrolledWindow = new Gtk.ScrolledWindow({
      child: rainbowTextView,
      vexpand: false,
      min_content_height: 120,
      has_frame: true,
    });
    rainbowBox.append(scrolledWindow);

    const rainbowErrorLabel = new Gtk.Label({
      wrap: true,
      xalign: 0,
      css_classes: ["error"],
      visible: false,
    });
    rainbowBox.append(rainbowErrorLabel);
    group.add(rainbowBox);

    // Validation
    const validateRainbowConfig = (text, mode) => {
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
        if (i < lines.length - 1) {
          if (parts.length < 2) return `Line ${i + 1}: missing parameter.`;
          const param = parseFloat(parts[1]);
          if (isNaN(param) || param <= 0) {
            return `Line ${i + 1}: parameter must be a positive number.`;
          }
        }
      }
      return null;
    };

    const rainbowBuffer = rainbowTextView.get_buffer();
    rainbowBuffer.connect("changed", () => {
      const mode = settings.get_string("color-mode");
      if (mode === "solid") return;

      const text = rainbowBuffer.text;
      const error = validateRainbowConfig(text, mode);
      if (error) {
        rainbowErrorLabel.set_text(error);
        rainbowErrorLabel.visible = true;
      } else {
        rainbowErrorLabel.visible = false;
        const key = `rainbow-${mode.replace("rainbow-", "")}-config`;
        settings.set_string(key, text);
      }
    });

    // Update UI based on color mode
    const updateColorModeUI = () => {
      const mode = settings.get_string("color-mode");
      const isSolid = mode === "solid";

      colorRow.visible = isSolid;
      alphaRow.visible = isSolid;
      rainbowBox.visible = !isSolid;

      if (!isSolid) {
        const key = `rainbow-${mode.replace("rainbow-", "")}-config`;
        const text = settings.get_string(key);
        rainbowBuffer.set_text(text, -1);

        if (mode === "rainbow-fixed") {
          rainbowDescLabel.set_text(
            "Format per line: #RRGGBB distance(px). The last color does not need a distance.\nExample: red for 50px, then green for 50px, then blue forever."
          );
        } else if (mode === "rainbow-ratio") {
          rainbowDescLabel.set_text(
            "Format per line: #RRGGBB ratio(positive number). Values are normalized automatically.\nExample: ratios 1, 1, 1 split the trail into three equal parts."
          );
        } else if (mode === "rainbow-time") {
          rainbowDescLabel.set_text(
            "Format per line: #RRGGBB time(ms). The last color does not need a time.\nExample: red for 500ms, then green for 500ms, then blue."
          );
        }

        // Re-validate
        const error = validateRainbowConfig(rainbowBuffer.text, mode);
        if (error) {
          rainbowErrorLabel.set_text(error);
          rainbowErrorLabel.visible = true;
        } else {
          rainbowErrorLabel.visible = false;
        }
      }
    };

    colorModeRow.connect("notify::selected", () => {
      const idx = colorModeRow.get_selected();
      const modes = ["solid", "rainbow-fixed", "rainbow-ratio", "rainbow-time"];
      settings.set_string("color-mode", modes[idx] ?? "solid");
      updateColorModeUI();
    });

    updateColorModeUI();

    // Reset button
    const resetGroup = new Adw.PreferencesGroup();
    page.add(resetGroup);

    const resetRow = new Adw.ActionRow({
      title: _("Reset to Defaults"),
      subtitle: _("Restore all settings to their default values"),
    });

    const resetButton = new Gtk.Button({
      label: _("Reset"),
      valign: Gtk.Align.CENTER,
      css_classes: ["destructive-action"],
    });

    resetButton.connect("clicked", () => {
      settings.set_int("fade-duration", 200);
      settings.set_int("line-width", 8);
      settings.set_value("color", new GLib.Variant("ad", [1.0, 1.0, 1.0]));
      settings.set_double("alpha", 0.5);
      settings.set_string("render-mode", "precise");
      settings.set_string("color-mode", "solid");
      settings.set_string("rainbow-fixed-config", "#FF0000 50\n#00FF00 50\n#0000FF");
      settings.set_string("rainbow-ratio-config", "#FF0000 1\n#00FF00 1\n#0000FF 1");
      settings.set_string("rainbow-time-config", "#FF0000 500\n#00FF00 500\n#0000FF");

      fadeDurationRow.set_value(200);
      lineWidthRow.set_value(8);
      colorButton.set_rgba(this._arrayToRgba([1.0, 1.0, 1.0]));
      alphaScale.set_value(0.5);
      renderModeRow.set_selected(0);
      colorModeRow.set_selected(0);
      updateColorModeUI();
    });

    resetRow.add_suffix(resetButton);
    resetGroup.add(resetRow);
  }

  _arrayToRgba(colorArray) {
    const rgba = new Gdk.RGBA();
    rgba.red = colorArray[0];
    rgba.green = colorArray[1];
    rgba.blue = colorArray[2];
    rgba.alpha = colorArray.length > 3 ? colorArray[3] : 1.0;
    return rgba;
  }
}
