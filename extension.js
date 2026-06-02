import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Cairo from "gi://cairo";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { getPointerWatcher } from "resource:///org/gnome/shell/ui/pointerWatcher.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// 注意：刻意不使用 GObject.registerClass 继承 St/Clutter 类。
// 自定义 GType 无法注销，其 vfunc 跳板在进程退出时清理会触发 GJS 内省终结崩溃
// （注销时整机黑屏的根因）。改用普通实例 + 信号/约束的委托模式。

export default class MouseTrailExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._fadeLength = this._settings.get_int("fade-duration");
    this._lineWidth = this._settings.get_int("line-width");
    this._colorArray = this._settings.get_value("color").deep_unpack();
    this._alpha = this._settings.get_double("alpha");
    this._renderMode = this._settings.get_string("render-mode");
    this._colorMode = this._settings.get_string("color-mode");
    this._parseRainbowConfig();

    this._points = [];
    this._prev_len = 0;

    // 普通实例（非自定义子类）。reactive: false 使其不参与输入拾取，鼠标事件穿透到下层。
    this._cont = new Clutter.Actor({ reactive: false });
    this._drawingLayer = new St.DrawingArea({ reactive: false });
    this._drawingLayer.set_size(global.stage.width, global.stage.height);

    this._cont.add_child(this._drawingLayer);
    // 绘制层尺寸跟随容器（替代原 vfunc_parent_set 中的绑定）
    this._drawingLayer.add_constraint(
      new Clutter.BindConstraint({
        coordinate: Clutter.BindCoordinate.SIZE,
        source: this._cont,
      }),
    );
    global.stage.add_child(this._cont);

    // 通过 repaint 信号绘制（替代原 vfunc_repaint）
    this._repaintId = this._drawingLayer.connect("repaint", (area) => {
      const cr = area.get_context();
      try {
        this._onRepaint(cr);
      } catch (_) {}
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

    this._pointerWatcher = getPointerWatcher();
    this.update_pointer_watcher();

    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
      if (this._points.length >= 3 || this._prev_len >= 3)
        this._drawingLayer?.queue_repaint();
      return GLib.SOURCE_CONTINUE;
    });

    this._settingsConnections = [];
    this._settingsConnections.push(
      this._settings.connect("changed::fade-duration", () => {
        this._fadeLength = this._settings.get_int("fade-duration");
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::line-width", () => {
        this._lineWidth = this._settings.get_int("line-width");
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::color", () => {
        this._colorArray = this._settings.get_value("color").deep_unpack();
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::alpha", () => {
        this._alpha = this._settings.get_double("alpha");
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::render-mode", () => {
        this._renderMode = this._settings.get_string("render-mode");
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::color-mode", () => {
        this._colorMode = this._settings.get_string("color-mode");
        this._parseRainbowConfig();
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::rainbow-fixed-config", () => {
        if (this._colorMode === "rainbow-fixed") this._parseRainbowConfig();
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::rainbow-ratio-config", () => {
        if (this._colorMode === "rainbow-ratio") this._parseRainbowConfig();
      }),
    );
    this._settingsConnections.push(
      this._settings.connect("changed::rainbow-time-config", () => {
        if (this._colorMode === "rainbow-time") this._parseRainbowConfig();
      }),
    );
  }

  _updateMonitorCoverage() {
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

  disable() {
    // 关键：先停掉重绘定时器，避免会话拆除期间回调触碰被销毁的 actor 导致卡死。
    // 每一步独立 try/catch，确保单步失败不会中断整个清理流程。
    if (this._timeoutId) {
      try {
        GLib.Source.remove(this._timeoutId);
      } catch (_) {}
      this._timeoutId = null;
    }

    if (this._drawIntervalWatcher) {
      try {
        // 使用 PointerWatch 的公共 API，而非私有的 _removeWatch
        this._drawIntervalWatcher.remove();
      } catch (_) {}
      this._drawIntervalWatcher = null;
    }
    this._pointerWatcher = null;

    if (this._overviewShowingId) {
      try {
        Main.overview.disconnect(this._overviewShowingId);
      } catch (_) {}
      this._overviewShowingId = null;
    }

    if (this._monitorsChangedId) {
      try {
        Main.layoutManager.disconnect(this._monitorsChangedId);
      } catch (_) {}
      this._monitorsChangedId = null;
    }

    if (this._repaintId) {
      try {
        this._drawingLayer?.disconnect(this._repaintId);
      } catch (_) {}
      this._repaintId = null;
    }

    if (this._drawingLayer) {
      try {
        global.stage.remove_child(this._cont);
        // 销毁容器会一并销毁其子节点（绘制层）
        this._cont?.destroy();
      } catch (_) {}
      this._drawingLayer = null;
      this._cont = null;
    }

    this._points = [];

    if (this._settingsConnections) {
      this._settingsConnections.forEach((connection) => {
        try {
          this._settings?.disconnect(connection);
        } catch (_) {}
      });
      this._settingsConnections = null;
    }

    this._settings = null;
  }

  _getSpeedFactor(p1, p2, size) {
    const dt = p2[2] - p1[2];
    if (dt <= 0) return Infinity;
    const dist = ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5;
    return dist / dt / ((600 * size) / 1000);
  }

  _parseRainbowConfig() {
    const mode = this._colorMode;
    if (mode === "solid") {
      this._rainbowStops = null;
      return;
    }

    const key = `rainbow-${mode.replace("rainbow-", "")}-config`;
    const text = this._settings.get_string(key);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    this._rainbowStops = [];
    let acc = 0;

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(/\s+/);
      const hex = parts[0];
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;

      const isLast = i === lines.length - 1;
      const allowNoParam = isLast && mode === "rainbow-fixed";
      const hasParam = parts.length >= 2 && parts[1].length > 0;

      let length = 0;
      if (hasParam || !allowNoParam) {
        length = parseFloat(parts[1]);
        acc += length;
      } else {
        length = Infinity;
      }

      this._rainbowStops.push({ color: [r, g, b], length });
    }

    if (mode === "rainbow-ratio" && acc > 0) {
      this._rainbowStops.forEach((s) => {
        if (s.length !== Infinity) s.length /= acc;
      });
    }

    // 为 fixed 和 ratio 模式计算累计 param（用于 _getColorAt）
    let acc2 = 0;
    for (const stop of this._rainbowStops) {
      acc2 += stop.length;
      stop.param = stop.length === Infinity ? Infinity : acc2;
    }

    if (mode === "rainbow-time") {
      this._rainbowPeriod = acc;
      // 去掉最后一个虚拟 stop（period 位置的第一个颜色副本）
      // 保持 stops 为原始配置的颜色，在 _getTimeColor 中处理环形
    }
  }

  _lerpColor(c1, c2, t) {
    return [
      c1[0] + (c2[0] - c1[0]) * t,
      c1[1] + (c2[1] - c1[1]) * t,
      c1[2] + (c2[2] - c1[2]) * t,
    ];
  }

  _getColorAt(value) {
    const stops = this._rainbowStops;
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
    return this._lerpColor(s1.color, s2.color, t);
  }

  _getTimeColor(elapsed) {
    const stops = this._rainbowStops;
    if (!stops || stops.length < 2) return stops?.[0]?.color ?? [1, 1, 1];

    const period = this._rainbowPeriod;
    if (!period || period <= 0) return stops[0].color;

    const t = elapsed % period;

    // 找到 t 所在的区间
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
    const localT = stops[idx].length > 0 ? (t - prevAccumulated) / stops[idx].length : 0;

    const nextIdx = (idx + 1) % stops.length;
    return this._lerpColor(stops[idx].color, stops[nextIdx].color, localT);
  }

  _calculatePointColors(pts) {
    const colors = [];
    const mode = this._colorMode;

    if (mode === "rainbow-fixed") {
      let dist = 0;
      // 从光标位置（数组尾部/最新点）向头部累计，确保光标显示配置的起始颜色
      for (let i = pts.length - 1; i >= 0; i--) {
        if (i < pts.length - 1) {
          const dx = pts[i][0] - pts[i + 1][0];
          const dy = pts[i][1] - pts[i + 1][1];
          dist += Math.sqrt(dx * dx + dy * dy);
        }
        colors[i] = this._getColorAt(dist);
      }
    } else if (mode === "rainbow-ratio") {
      let totalDist = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        totalDist += Math.sqrt(dx * dx + dy * dy);
      }
      let dist = 0;
      // 从光标位置向头部累计，光标处 ratio=0（起始颜色）
      for (let i = pts.length - 1; i >= 0; i--) {
        if (i < pts.length - 1) {
          const dx = pts[i][0] - pts[i + 1][0];
          const dy = pts[i][1] - pts[i + 1][1];
          dist += Math.sqrt(dx * dx + dy * dy);
        }
        const ratio = totalDist > 0 ? dist / totalDist : 0;
        colors[i] = this._getColorAt(ratio);
      }
    }

    return colors;
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
      const elapsed = Date.now();
      const [r, g, b] = this._getTimeColor(elapsed);
      this._points.push([x - offsetX, y - offsetY, Date.now(), r, g, b]);
    } else {
      this._points.push([x - offsetX, y - offsetY, Date.now()]);
    }

    noise_cancel(this._points, this._lineWidth);
  }

  _onRepaint(cr) {
    // 会话拆除期间 disable() 可能已销毁 drawingLayer，此时直接跳过绘制
    if (!this._drawingLayer) return;

    const pts = this._points;
    const now = Date.now();
    if (pts.length >= 3) {
      const mode = this._renderMode;
      const colorMode = this._colorMode;
      const color = this._colorArray;
      const alpha = this._alpha;
      const size = this._lineWidth;
      cr.setLineWidth(size);

      const x_min = pts.reduce((a, p) => Math.min(a, p[0]), Infinity) - size;
      const x_max = pts.reduce((a, p) => Math.max(a, p[0]), 0) + size;
      const y_min = pts.reduce((a, p) => Math.min(a, p[1]), Infinity) - size;
      const y_max = pts.reduce((a, p) => Math.max(a, p[1]), 0) + size;
      this._drawingLayer.set_clip(x_min, y_min, x_max - x_min, y_max - y_min);

      const getColors = (idx1, idx2) => {
        if (colorMode === "solid") return [color, color];
        if (colorMode === "rainbow-time") {
          return [
            [pts[idx1][3], pts[idx1][4], pts[idx1][5]],
            [pts[idx2][3], pts[idx2][4], pts[idx2][5]],
          ];
        }
        // rainbow-fixed or rainbow-ratio: use pre-calculated colors
        return [this._pointColors[idx1], this._pointColors[idx2]];
      };

      let pointColors = null;
      if (colorMode === "rainbow-fixed" || colorMode === "rainbow-ratio") {
        pointColors = this._calculatePointColors(pts);
        this._pointColors = pointColors;
      }

      if (mode !== "precise") {
        const splits = split_line(pts);
        for (let it = 0; it < splits.length; it++) {
          const [sidx, eidx] = splits[it];
          const p1 = pts[sidx];
          const p2 = pts[eidx];
          const i3 = (splits[it + 1] ?? splits[it])[1];
          const p3 = pts[i3];

          const alpha_s = Math.min(
            sidx === 0 ? 0 : 1,
            ((now - p1[2]) / this._fadeLength) * 2,
            1 - (now - p1[2]) / this._fadeLength,
            this._getSpeedFactor(p1, p2, size),
          );
          const alpha_e = Math.min(
            ((now - p2[2]) / this._fadeLength) * 2,
            it === splits.length - 1 ? 0 : 1,
            1 - (now - p2[2]) / this._fadeLength,
            this._getSpeedFactor(p2, p3, size),
          );

          const [c1, c2] = getColors(sidx, eidx);
          const gradient = new Cairo.LinearGradient(p1[0], p1[1], p2[0], p2[1]);
          gradient.addColorStopRGBA(0, c1[0], c1[1], c1[2], alpha_s * alpha);
          gradient.addColorStopRGBA(1, c2[0], c2[1], c2[2], alpha_e * alpha);
          cr.setSource(gradient);
          cr.newPath();
          cr.moveTo(p1[0], p1[1]);
          if (mode === "fast") {
            for (let i = sidx; i < eidx; i++) {
              cr.lineTo(pts[i + 1][0], pts[i + 1][1]);
            }
          } else {
            for (let i = sidx; i < eidx; i++) {
              const p0 = i === 0 ? pts[i] : pts[i - 1];
              const p1 = pts[i];
              const p2 = [...pts[i + 1]];
              const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
              if (i === pts.length - 3) {
                p2[0] = Math.round((p1[0] + p2[0] + p3[0]) / 3);
                p2[1] = Math.round((p1[1] + p2[1] + p3[1]) / 3);
                p2[2] = Math.round((p1[2] + p2[2] + p3[2]) / 3);
              }
              const cp1x = p1[0] + (p2[0] - p0[0]) * 0.167;
              const cp1y = p1[1] + (p2[1] - p0[1]) * 0.167;
              const cp2x = p2[0] - (p3[0] - p1[0]) * 0.167;
              const cp2y = p2[1] - (p3[1] - p1[1]) * 0.167;
              cr.curveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
            }
          }
          cr.stroke();
        }
      } else {
        for (let i = 0; i < pts.length - 2; i++) {
          const p0 = i === 0 ? pts[i] : pts[i - 1];
          const p1 = pts[i];
          const p2 = [...pts[i + 1]];
          const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
          if (i === pts.length - 3) {
            p2[0] = Math.round((p1[0] + p2[0] + p3[0]) / 3);
            p2[1] = Math.round((p1[1] + p2[1] + p3[1]) / 3);
            p2[2] = Math.round((p1[2] + p2[2] + p3[2]) / 3);
          }

          const alpha_s = Math.min(
            ((now - p1[2]) / this._fadeLength) * 2,
            1 - (now - p1[2]) / this._fadeLength,
            this._getSpeedFactor(p1, p2, size),
          );
          const alpha_e =
            i === pts.length - 3
              ? 0
              : Math.min(
                  ((now - p2[2]) / this._fadeLength) * 2,
                  1 - (now - p2[2]) / this._fadeLength,
                  this._getSpeedFactor(p2, p3, size),
                );

          const [c1, c2] = getColors(i, i + 1);
          const gradient = new Cairo.LinearGradient(p1[0], p1[1], p2[0], p2[1]);
          gradient.addColorStopRGBA(0, c1[0], c1[1], c1[2], alpha_s * alpha);
          gradient.addColorStopRGBA(1, c2[0], c2[1], c2[2], alpha_e * alpha);
          cr.setSource(gradient);

          const cp1x = p1[0] + (p2[0] - p0[0]) * 0.167;
          const cp1y = p1[1] + (p2[1] - p0[1]) * 0.167;
          const cp2x = p2[0] - (p3[0] - p1[0]) * 0.167;
          const cp2y = p2[1] - (p3[1] - p1[1]) * 0.167;

          cr.newPath();
          cr.moveTo(p1[0], p1[1]);
          cr.curveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
          cr.stroke();
        }
      }
    }

    this._prev_len = pts.length;
    this._points = pts.filter((p) => now - p[2] < this._fadeLength);
  }
}

const split_line = (pts) => {
  let splits = [];
  let pidx = 0;
  let dir = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const cdir = Math.atan2(y2 - y1, x2 - x1);
    const delta =
      dir === null
        ? 0
        : Math.min(
            Math.abs(cdir - dir),
            Math.abs(cdir - dir + Math.PI * 2),
            Math.abs(cdir - dir - Math.PI * 2),
          );
    if (delta > Math.PI / 4) {
      splits.push([pidx, i]);
      pidx = i;
      dir = cdir;
    }
    if (dir === null) dir = cdir;
  }
  splits.push([pidx, pts.length - 1]);
  return splits;
};
