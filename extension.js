import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Cairo from "gi://cairo";
import GObject from "gi://GObject";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { getPointerWatcher } from "resource:///org/gnome/shell/ui/pointerWatcher.js";

// 自定义绘图层，继承自 St.DrawingArea
const MouseTrailLayer = GObject.registerClass(
  {
    GTypeName: "MouseTrailLayer",
  },
  class MouseTrailLayer extends St.DrawingArea {
    _init(extension) {
      this._extension = extension;
      // 设置 reactive 为 false，确保此层不拦截鼠标事件
      super._init({ reactive: false });
      this.set_track_hover(false);
      this.set_reactive(false);
      // 初始时设置尺寸为屏幕大小
      this.set_size(global.stage.width, global.stage.height);
    }

    // 当父容器发生变化时，自动绑定大小
    vfunc_parent_set() {
      this.clear_constraints();
      const parent = this.get_parent();
      if (parent) {
        this.add_constraint(
          new Clutter.BindConstraint({
            coordinate: Clutter.BindCoordinate.SIZE,
            source: parent,
          }),
        );
      }
    }

    // 重写绘制方法：获取 Cairo 上下文，调用扩展提供的重绘回调，并释放上下文资源
    vfunc_repaint() {
      const cr = this.get_context();
      try {
        this._extension._onRepaint(cr);
      } catch (_) {}
      cr.$dispose();
    }
  },
);

export default class MouseTrailExtension extends Extension {
  enable() {
    // 获取设置
    this._settings = this.getSettings();
    this._fadeLength = this._settings.get_int("fade-duration");
    this._lineWidth = this._settings.get_int("line-width");
    this._colorArray = this._settings.get_value("color").deep_unpack();
    this._alpha = this._settings.get_double("alpha");
    this._renderMode = this._settings.get_string("render-mode");

    // 初始化轨迹点数组
    this._points = [];
    this._prev_len = 0;

    // 创建自定义绘图层（全屏覆盖，非交互型）
    this._cont = new Clutter.Actor();
    this._drawingLayer = new MouseTrailLayer(this);

    // 将绘图层添加到 chrome 层，确保始终位于最上层
    setTimeout(() => global.top_window_group.add_child(this._cont), 5000);
    this._cont.add_child(this._drawingLayer);

    // 捕获全局鼠标移动事件，记录鼠标坐标及时间戳
    this._pointerWatcher = getPointerWatcher();
    this.update_pointer_watcher();

    // 设置定时器，定时调用 queue_repaint 保证轨迹淡出效果平滑更新
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
      if (this._points.length >= 3 || this._prev_len >= 3)
        this._drawingLayer?.queue_repaint();
      return GLib.SOURCE_CONTINUE;
    });

    // 监听设置变化，实时更新配置
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
  }

  update_pointer_watcher() {
    if (this._drawIntervalWatcher) {
      this._pointerWatcher._removeWatch(this._drawIntervalWatcher);
    }
    this._drawIntervalWatcher = this._pointerWatcher.addWatch(
      20,
      this._onCapturedEvent.bind(this),
    );
  }

  disable() {
    // 断开全局鼠标事件监听
    if (this._drawIntervalWatcher) {
      this._pointerWatcher._removeWatch(this._drawIntervalWatcher);
      this._drawIntervalWatcher = null;
    }

    // 移除定时器
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }

    // 移除并销毁绘图层
    if (this._drawingLayer) {
      this._cont.remove_child(this._drawingLayer);
      global.top_window_group.remove_child(this._cont);
      this._drawingLayer.destroy();
      this._cont.destroy();
      this._drawingLayer = null;
      this._cont = null;
    }

    // 清空轨迹点数据
    this._points = [];

    // 断开设置监听
    if (this._settingsConnections) {
      this._settingsConnections.forEach((connection) => {
        if (this._settings) {
          this._settings.disconnect(connection);
        }
      });
      this._settingsConnections = null;
    }

    // 清理设置
    this._settings = null;
  }

  /**
   * 捕获全局鼠标移动事件的回调
   */
  _onCapturedEvent(x, y) {
    // 噪点消除，用于过滤间距小于1.5倍线条宽度的点
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
    // 记录当前鼠标位置和时间戳
    this._points.push([x, y, Date.now()]);
    noise_cancel(this._points, this._lineWidth);
  }

  /**
   * 绘图层重绘回调，利用 Cairo 绘制鼠标轨迹（两两连接）
   * 旧的轨迹点会根据存活时间计算透明度，达到淡出效果。
   *
   * @param {Cairo.Context} cr
   */
  _onRepaint(cr) {
    const pts = this._points;
    const now = Date.now();
    if (pts.length >= 3) {
      const mode = this._renderMode;
      const color = this._colorArray;
      const alpha = this._alpha;
      const size = this._lineWidth;
      cr.setLineWidth(size);

      // 设定裁剪框以提升性能
      const x_min = pts.reduce((a, p) => Math.min(a, p[0]), Infinity) - size;
      const x_max = pts.reduce((a, p) => Math.max(a, p[0]), 0) + size;
      const y_min = pts.reduce((a, p) => Math.min(a, p[1]), Infinity) - size;
      const y_max = pts.reduce((a, p) => Math.max(a, p[1]), 0) + size;
      this._drawingLayer.set_clip(x_min, y_min, x_max - x_min, y_max - y_min);

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
            ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5 /
              (p2[2] - p1[2]) /
              ((600 * size) / 1000),
          );
          const alpha_e = Math.min(
            ((now - p2[2]) / this._fadeLength) * 2,
            it === splits.length - 1 ? 0 : 1,
            1 - (now - p2[2]) / this._fadeLength,
            ((p2[0] - p3[0]) ** 2 + (p2[1] - p3[1]) ** 2) ** 0.5 /
              (p3[2] - p2[2]) /
              ((600 * size) / 1000),
          );

          const gradient = new Cairo.LinearGradient(p1[0], p1[1], p2[0], p2[1]);
          gradient.addColorStopRGBA(
            0,
            color[0],
            color[1],
            color[2],
            alpha_s * alpha,
          );
          gradient.addColorStopRGBA(
            1,
            color[0],
            color[1],
            color[2],
            alpha_e * alpha,
          );
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
            ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5 /
              (p2[2] - p1[2]) /
              ((600 * size) / 1000),
          );
          const alpha_e =
            i === pts.length - 3
              ? 0
              : Math.min(
                  ((now - p2[2]) / this._fadeLength) * 2,
                  1 - (now - p2[2]) / this._fadeLength,
                  ((p2[0] - p3[0]) ** 2 + (p2[1] - p3[1]) ** 2) ** 0.5 /
                    (p3[2] - p2[2]) /
                    ((600 * size) / 1000),
                );

          const gradient = new Cairo.LinearGradient(p1[0], p1[1], p2[0], p2[1]);
          gradient.addColorStopRGBA(
            0,
            color[0],
            color[1],
            color[2],
            alpha_s * alpha,
          );
          gradient.addColorStopRGBA(
            1,
            color[0],
            color[1],
            color[2],
            alpha_e * alpha,
          );
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

    // 过滤掉已超出淡出时间的轨迹点，避免数组无限增长
    this._prev_len = pts.length;
    this._points = pts.filter((p) => now - p[2] < this._fadeLength);
  }
}

// 将曲线按照线段的方向向量进行分段，以优化渐变的渲染
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
