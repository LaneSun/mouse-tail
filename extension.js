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

    // 初始化轨迹点数组
    this._points = [];

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
      if (this._drawingLayer) {
        this._drawingLayer.queue_repaint();
      }
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
    // 记录当前鼠标位置和时间戳
    if (this._points.length > 0) {
      const { x: px, y: py } = this._points.at(-1);
      if (x === px && y === py) {
        this._points.at(-1).time = Date.now();
        if (this._drawingLayer) {
          this._drawingLayer.queue_repaint();
        }
        return;
      }
    }
    this._points.push({ x, y, time: Date.now() });
    if (this._drawingLayer) {
      this._drawingLayer.queue_repaint();
    }
  }

  /**
   * 绘图层重绘回调，利用 Cairo 绘制鼠标轨迹（两两连接）
   * 旧的轨迹点会根据存活时间计算透明度，达到淡出效果。
   *
   * @param {Cairo.Context} cr
   */
  _onRepaint(cr) {
    const now = Date.now();

    cr.setLineWidth(this._lineWidth);

    // 遍历轨迹点，依次两两连接绘制线段
    if (this._points.length >= 3) {
      // 构建平滑路径
      cr.newPath();
      const pts = this._points;

      // 使用 Catmull-Rom 插值转换为贝塞尔曲线
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = i === 0 ? pts[i] : pts[i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = i + 2 < pts.length ? pts[i + 2] : p2;

        const age = now - p1.time;
        if (age > this._fadeLength) continue; // 超出淡出时长的点不绘制

        const alpha = Math.min(
          i / (pts.length - 1),
          (Math.max(0, pts.length - i - 3) / 16) ** 0.5,
          1 - age / this._fadeLength,
        );
        cr.setSourceRGBA(
          this._colorArray[0],
          this._colorArray[1],
          this._colorArray[2],
          alpha * this._alpha,
        );

        // 计算控制点（公式参考 Catmull-Rom 到 Cubic Bezier 的转换）
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        cr.moveTo(p1.x, p1.y);
        cr.curveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        cr.stroke();
      }
    }

    // 过滤掉已超出淡出时间的轨迹点，避免数组无限增长
    this._points = this._points.filter((p) => now - p.time < this._fadeLength);
  }
}
