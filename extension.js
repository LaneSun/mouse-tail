import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { getPointerWatcher } from "resource:///org/gnome/shell/ui/pointerWatcher.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  readStyleState,
  effectiveFor,
  ensureStyleMigrated,
  parseRainbowStops,
  timeColorAt,
} from "./styleEngine.js";

import { drawTrail, calculatePointColors } from "./trailRender.js";

export default class MouseTrailExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    ensureStyleMigrated(this._settings);
    this._style = readStyleState(this._settings);

    this._points = [];
    // 画布原点（轨迹包围盒左上角）
    this._originX = 0;
    this._originY = 0;

    this._cont = new Clutter.Actor({ reactive: false });

    this._drawingLayer = new St.DrawingArea({ reactive: false, visible: false });

    Shell.util_set_hidden_from_pick(this._cont, true);
    Shell.util_set_hidden_from_pick(this._drawingLayer, true);

    this._cont.add_child(this._drawingLayer);
    global.stage.add_child(this._cont);

    this._repaintId = this._drawingLayer.connect("repaint", (area) => {
      const cr = area.get_context();
      this._onRepaint(cr);
      cr.$dispose();
    });

    this._updateMonitorCoverage();

    this._monitorsChangedId = Main.layoutManager.connect(
      "monitors-changed",
      () => {
        this._updateMonitorCoverage();
      },
    );

    this._overviewShowingId = Main.overview.connect("showing", () => {
      global.stage.set_child_above_sibling(this._cont, null);
    });

    // —— 样式状态监听：系统配色方案或两个样式键任一变化即重算 ——
    // St.Settings 单例：新版 shell 静态方法为 get()，旧版为 get_default()
    this._stSettings = St.Settings.get
      ? St.Settings.get()
      : St.Settings.get_default();
    this._colorSchemeId = this._stSettings.connect(
      "notify::color-scheme",
      () => this._recompute(),
    );

    this._styleKeysIds = [
      "style-defaults",
      "style-dark-overrides",
    ].map((key) =>
      this._settings.connect(`changed::${key}`, () => {
        this._style = readStyleState(this._settings);
        this._recompute();
      }),
    );

    this._recompute();

    this._pointerWatcher = getPointerWatcher();
    this.update_pointer_watcher();

    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
      this._tick();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _updateMonitorCoverage() {
    if (this._drawingLayer) this._drawingLayer.visible = false;
    const monitors = Main.layoutManager.monitors;
    if (monitors.length === 0) {
      this._monitorOffsetX = 0;
      this._monitorOffsetY = 0;
      this._cont.set_position(0, 0);
      this._cont.set_size(global.stage.width, global.stage.height);
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const monitor of monitors) {
      minX = Math.min(minX, monitor.x);
      minY = Math.min(minY, monitor.y);
      maxX = Math.max(maxX, monitor.x + monitor.width);
      maxY = Math.max(maxY, monitor.y + monitor.height);
    }

    this._monitorOffsetX = minX;
    this._monitorOffsetY = minY;
    this._cont.set_position(minX, minY);
    this._cont.set_size(maxX - minX, maxY - minY);
    this._points = [];
  }

  update_pointer_watcher() {
    if (this._drawIntervalWatcher) {
      this._drawIntervalWatcher.remove();
    }
    this._drawIntervalWatcher = this._pointerWatcher.addWatch(
      20,
      this._onCapturedEvent.bind(this),
    );
  }

  // 系统配色方案判定。DEFAULT/PREFER_LIGHT 视为浅色（与 libadwaita
  // 一致）；旧版 shell 枚举中的 LIGHT/DARK 一并归入，GNOME 50 已移除
  // 这两个值（undefined，比较恒为 false）。
  _isDarkSystem() {
    const scheme = this._stSettings.color_scheme;
    return !(
      scheme === St.SystemColorScheme.DEFAULT ||
      scheme === St.SystemColorScheme.PREFER_LIGHT ||
      scheme === St.SystemColorScheme.LIGHT
    );
  }

  // 样式重算：默认补丁 +（暗色时）覆盖补丁 → 应用到渲染字段
  _recompute() {
    const effective = effectiveFor(this._style, this._isDarkSystem());

    this._fadeLength = effective["fade-duration"];
    this._lineWidth = effective["line-width"];
    this._colorArray = effective["color"];
    this._alpha = effective["alpha"];
    this._colorMode = effective["color-mode"];
    this._parseRainbowConfig(effective);

    this._drawingLayer?.queue_repaint();
  }

  _tick() {
    const layer = this._drawingLayer;
    if (!layer) return;

    const now = Date.now();
    const pts = (this._points = this._points.filter(
      (p) => now - p[2] < this._fadeLength,
    ));

    if (pts.length < 3) {
      layer.visible = false;
      return;
    }

    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    let maxSq = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p[0] < xMin) xMin = p[0];
      if (p[0] > xMax) xMax = p[0];
      if (p[1] < yMin) yMin = p[1];
      if (p[1] > yMax) yMax = p[1];
      for (let k = 1; k <= 2 && i + k < pts.length; k++) {
        const dx = pts[i + k][0] - p[0];
        const dy = pts[i + k][1] - p[1];
        const sq = dx * dx + dy * dy;
        if (sq > maxSq) maxSq = sq;
      }
    }

    const pad = this._lineWidth * 2 + Math.ceil(Math.sqrt(maxSq) * 0.167) + 1;
    const ox = Math.floor(xMin - pad);
    const oy = Math.floor(yMin - pad);
    const w = Math.ceil(xMax + pad) - ox;
    const h = Math.ceil(yMax + pad) - oy;
    this._originX = ox;
    this._originY = oy;

    const resized = w !== layer.width || h !== layer.height;
    layer.set_position(ox, oy);
    if (resized) layer.set_size(w, h);
    layer.visible = true;
    if (!resized) layer.queue_repaint();
  }

  disable() {
    if (this._colorSchemeId) {
      this._stSettings.disconnect(this._colorSchemeId);
      this._colorSchemeId = null;
    }
    this._stSettings = null;

    for (const id of this._styleKeysIds ?? []) {
      this._settings?.disconnect(id);
    }
    this._styleKeysIds = null;

    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }

    if (this._drawIntervalWatcher) {
      this._drawIntervalWatcher.remove();
      this._drawIntervalWatcher = null;
    }
    this._pointerWatcher = null;

    if (this._overviewShowingId) {
      Main.overview.disconnect(this._overviewShowingId);
      this._overviewShowingId = null;
    }

    if (this._monitorsChangedId) {
      Main.layoutManager.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = null;
    }

    if (this._repaintId) {
      this._drawingLayer?.disconnect(this._repaintId);
      this._repaintId = null;
    }

    if (this._drawingLayer) {
      global.stage.remove_child(this._cont);
      this._drawingLayer.destroy();
      this._cont?.destroy();
      this._drawingLayer = null;
      this._cont = null;
    }

    this._points = [];
    this._style = null;

    this._settings = null;
  }

  _parseRainbowConfig(effective) {
    const mode = this._colorMode;
    this._rainbow = parseRainbowStops(
      mode,
      effective[`rainbow-${mode.replace("rainbow-", "")}-config`],
    );
  }

  _onCapturedEvent(x, y) {
    function noise_cancel(points, width) {
      if (points.length <= 2) return points;
      const next = points.at(-1);
      const cur = points.at(-2);
      const prev = points.at(-3);
      if ((next[0] - prev[0]) ** 2 + (next[1] - prev[1]) ** 2 < width ** 2) {
        points.splice(-2, 1);
      } else {
        cur[0] = Math.round((next[0] + prev[0] + cur[0]) / 3);
        cur[1] = Math.round((next[1] + prev[1] + cur[1]) / 3);
        cur[2] = Math.round((next[2] + prev[2] + cur[2]) / 3);
      }
    }

    const offsetX = this._monitorOffsetX ?? 0;
    const offsetY = this._monitorOffsetY ?? 0;

    if (this._colorMode === "rainbow-time") {
      const [r, g, b] = timeColorAt(this._rainbow, Date.now());
      this._points.push([x - offsetX, y - offsetY, Date.now(), r, g, b]);
    } else {
      this._points.push([x - offsetX, y - offsetY, Date.now()]);
    }

    noise_cancel(this._points, this._lineWidth);
  }

  _onRepaint(cr) {
    if (!this._drawingLayer) return;

    const pts = this._points;
    if (pts.length < 3) return;

    const colorMode = this._colorMode;
    let pointColors = null;
    if (colorMode === "rainbow-fixed" || colorMode === "rainbow-ratio") {
      pointColors = calculatePointColors(pts, colorMode, this._rainbow);
    }

    cr.translate(-this._originX, -this._originY);
    drawTrail(cr, pts, {
      size: this._lineWidth,
      fadeLength: this._fadeLength,
      colorMode,
      color: this._colorArray,
      alpha: this._alpha,
      now: Date.now(),
      pointColors,
    });
  }
}
