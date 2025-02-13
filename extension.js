import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';
import GObject from 'gi://GObject';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getPointerWatcher } from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

// 配置参数
const FADE_DURATION = 200; // 轨迹淡出时长（毫秒）
const LINE_WIDTH    = 8;    // 线条宽度

// 自定义绘图层，继承自 St.DrawingArea
const MouseTrailLayer = GObject.registerClass({
    GTypeName: 'MouseTrailLayer'
}, class MouseTrailLayer extends St.DrawingArea {
    _init(extension) {
        this._extension = extension;
        // 设置 reactive 为 false，确保此层不拦截鼠标事件
        super._init({ reactive: false });
        // 初始时设置尺寸为屏幕大小
        this.set_size(global.stage.width, global.stage.height);
    }

    // 当父容器发生变化时，自动绑定大小
    vfunc_parent_set() {
        this.clear_constraints();
        let parent = this.get_parent();
        if (parent) {
            this.add_constraint(new Clutter.BindConstraint({
                coordinate: Clutter.BindCoordinate.SIZE,
                source: parent
            }));
        }
    }

    // 重写绘制方法：获取 Cairo 上下文，调用扩展提供的重绘回调，并释放上下文资源
    vfunc_repaint() {
        let cr = this.get_context();
        try {
            this._extension._onRepaint(cr);
        } catch (e) {
            logError(e, 'Error during mouse trail repaint');
        }
        cr.$dispose();
    }
});

export default class MouseTrailExtension extends Extension {
    enable() {
        // 初始化轨迹点数组
        this._points = [];

        // 创建自定义绘图层（全屏覆盖，非交互型）
        this._drawingLayer = new MouseTrailLayer(this);

        // 将绘图层添加到 chrome 层，确保始终位于最上层
        Main.layoutManager.addChrome(this._drawingLayer);

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
    }
    
    update_pointer_watcher() {
        if (this._drawIntervalWatcher) {
            this._pointerWatcher._removeWatch(this._drawIntervalWatcher);
        }
        this._drawIntervalWatcher = this._pointerWatcher.addWatch(20, this._onCapturedEvent.bind(this));
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
            Main.layoutManager.removeChrome(this._drawingLayer);
            this._drawingLayer.destroy();
            this._drawingLayer = null;
        }

        // 清空轨迹点数据
        this._points = [];
    }

    /**
     * 捕获全局鼠标移动事件的回调
     */
    _onCapturedEvent(x, y) {
        // 记录当前鼠标位置和时间戳
        if (this._points.length > 0) {
            const {x: px, y: py} = this._points.at(-1);
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
        let now = Date.now();

        cr.setLineWidth(LINE_WIDTH);

        // 遍历轨迹点，依次两两连接绘制线段
        if (this._points.length >= 3) {
        
            // 构建平滑路径
            cr.newPath();
            let pts = this._points;

            // 使用 Catmull-Rom 插值转换为贝塞尔曲线
            for (let i = 0; i < pts.length - 1; i++) {
                let p0 = (i === 0) ? pts[i] : pts[i - 1];
                let p1 = pts[i];
                let p2 = pts[i + 1];
                let p3 = (i + 2 < pts.length) ? pts[i + 2] : p2;

                let age = now - p1.time;
                if (age > FADE_DURATION) continue; // 超出淡出时长的点不绘制
                
                let alpha = Math.min(
                    i / (pts.length - 1),
                    (Math.max(0, pts.length - i - 3) / 16) ** 0.5,
                    1 - (age / FADE_DURATION),
                );
                cr.setSourceRGBA(1, 1, 1, alpha * 0.5);

                // 计算控制点（公式参考 Catmull-Rom 到 Cubic Bezier 的转换）
                let cp1x = p1.x + (p2.x - p0.x) / 6;
                let cp1y = p1.y + (p2.y - p0.y) / 6;
                let cp2x = p2.x - (p3.x - p1.x) / 6;
                let cp2y = p2.y - (p3.y - p1.y) / 6;

                cr.moveTo(p1.x, p1.y);
                cr.curveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
                cr.stroke();
            }
        
        }

        // 过滤掉已超出淡出时间的轨迹点，避免数组无限增长
        this._points = this._points.filter(p => (now - p.time) < FADE_DURATION);
    }
}

