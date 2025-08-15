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
    // Create a preferences page
    const page = new Adw.PreferencesPage({
      title: _("General"),
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    // Create a preferences group
    const group = new Adw.PreferencesGroup({
      title: _("Mouse Tail Settings"),
      description: _("Configure the appearance of the mouse tail effect"),
    });
    page.add(group);

    // Get settings
    const settings = this.getSettings("org.gnome.shell.extensions.mouse-tail");

    // Fade Duration setting
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

    // Line Width setting
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

    // Color setting
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
      const colorArray = [rgba.red, rgba.green, rgba.blue];
      settings.set_value("color", new GLib.Variant("ad", colorArray));
    });

    colorRow.add_suffix(colorButton);
    group.add(colorRow);

    // Alpha (transparency) setting
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

    // Render Mode setting
    const renderModeRow = new Adw.ComboRow({
      title: _("Render Mode"),
      subtitle: _("Choose between precise smooth curves or fast simple lines"),
    });

    const renderModeModel = new Gtk.StringList();
    renderModeModel.append(_("Precise"));
    renderModeModel.append(_("Balance"));
    renderModeModel.append(_("Fast"));
    renderModeRow.set_model(renderModeModel);

    const currentRenderMode = settings.get_string("render-mode");
    let selectedIndex = 0;
    if (currentRenderMode === "balance") selectedIndex = 1;
    else if (currentRenderMode === "fast") selectedIndex = 2;
    renderModeRow.set_selected(selectedIndex);

    renderModeRow.connect("notify::selected", () => {
      const selected = renderModeRow.get_selected();
      let mode = "precise";
      if (selected === 1) mode = "balance";
      else if (selected === 2) mode = "fast";
      settings.set_string("render-mode", mode);
    });

    group.add(renderModeRow);

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
      // Reset to default values
      settings.set_int("fade-duration", 200);
      settings.set_int("line-width", 8);
      settings.set_value("color", new GLib.Variant("ad", [1.0, 1.0, 1.0]));
      settings.set_double("alpha", 0.5);
      settings.set_string("render-mode", "precise");

      // Update UI
      fadeDurationRow.set_value(200);
      lineWidthRow.set_value(8);
      colorButton.set_rgba(this._arrayToRgba([1.0, 1.0, 1.0]));
      alphaScale.set_value(0.5);
      renderModeRow.set_selected(0);
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
