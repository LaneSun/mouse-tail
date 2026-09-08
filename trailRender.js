// 轨迹渲染共享实现：extension 的实际绘制与 prefs 的预览调用同一算法，
// 保证预览所见即所得。全部从 extension.js 原实现原样迁移。
import Cairo from "gi://cairo";

import { colorAtStops } from "./styleEngine.js";

// 速度因子：移动越快轨迹越透明（600*size 像素/秒 为基准速度）
export function getSpeedFactor(p1, p2, size) {
  const dt = p2[2] - p1[2];
  if (dt <= 0) return Infinity;
  const dist = ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5;
  return dist / dt / ((600 * size) / 1000);
}

// rainbow-fixed / rainbow-ratio 的逐点取色（距离从最新点向旧点累积）
export function calculatePointColors(pts, mode, parsed) {
  const colors = [];
  const stops = parsed?.stops;

  if (mode === "rainbow-fixed") {
    let dist = 0;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (i < pts.length - 1) {
        const dx = pts[i][0] - pts[i + 1][0];
        const dy = pts[i][1] - pts[i + 1][1];
        dist += Math.sqrt(dx * dx + dy * dy);
      }
      colors[i] = colorAtStops(stops, dist);
    }
  } else if (mode === "rainbow-ratio") {
    let totalDist = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      totalDist += Math.sqrt(dx * dx + dy * dy);
    }
    let dist = 0;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (i < pts.length - 1) {
        const dx = pts[i][0] - pts[i + 1][0];
        const dy = pts[i][1] - pts[i + 1][1];
        dist += Math.sqrt(dx * dx + dy * dy);
      }
      const ratio = totalDist > 0 ? dist / totalDist : 0;
      colors[i] = colorAtStops(stops, ratio);
    }
  }

  return colors;
}

// —— 预览轨迹合成 ——
// 构造一条静态"轨迹快照"，供 prefs 预览使用：
// - 波形固定为一个标准 sin 周期（从中点高度出发，上凸过峰、下凸过谷、
//   回到中点），固定等分为 12 段（13 个采样点，x 取整）；
// - 时间窗 now = fadeDuration/3：采样点 age 从 fadeDuration/3 线性递减
//   到 0，包络峰值 2/3（authentic 峰值）恰落在首采样点，轨迹呈亮体 +
//   渐隐尖的真实拖尾观感，且调度与线宽/宽度无关，观感统一；
// - 末尾附加 1 个 age=0 的延伸点，使 drawTrail 对最后 3 点的均值平滑
//   只影响不可见尖端。
// 返回 { pts: [x, y, ts], now }；彩虹色由调用方按需嵌入。
export function synthPreviewTrail(w, h0, y0, lineWidth, fadeDuration) {
  const fl = Math.max(1, fadeDuration);
  const half = h0 / 2;
  const A = Math.max(4, Math.min(18, half - lineWidth / 2 - 6));
  const margin = 14;
  const wl0 = Math.max(1, w - 2 * margin);
  const N = 12; // 固定 12 段
  const now = Math.max(1, Math.round(fl / 3));
  const pts = [];
  for (let k = 0; k <= N + 1; k++) {
    pts.push([
      Math.round(margin + (k / N) * wl0),
      y0 + half - A * Math.sin((k / N) * 2 * Math.PI),
      Math.round((Math.min(k, N) / N) * now),
    ]);
  }
  return { pts, now };
}

// —— 预览专用绘制：单次渐变描边，无拼接缝 ——
// 预览为横贯画布的单周期 sin，包络与彩虹颜色均沿 x 轴逐采样点线性
// 变化，因此以一条沿 x 轴、含全部采样点色标的 LinearGradient 描边
// 整条 Catmull-Rom 路径，即可精确复现 drawTrail precise 分支的逐段
// 渐变视觉；整条路径一次描边不存在任何拼接帽线，顺序 alpha 合成的
// 互补误差（逐对描边斜向帽线上的 1px 亮缝）无从产生，任意透明度下
// 干净。仅预览使用；扩展本体仍用 drawTrail 的原始逐对描边。
export function drawTrailPreview(cr, pts, opts) {
  const { size, fadeLength, colorMode, color, alpha, now } = opts;
  const pointColors = opts.pointColors;

  const gradient = new Cairo.LinearGradient(pts[0][0], 0, pts[12][0], 0);
  for (let k = 0; k <= 12; k++) {
    const p = pts[k];
    const age = now - p[2];
    const a = Math.min((2 * age) / fadeLength, 1 - age / fadeLength) * alpha;
    let c = color;
    if (colorMode === "rainbow-time") {
      c = Number.isFinite(p[3]) ? [p[3], p[4], p[5]] : color;
    } else if (colorMode !== "solid") {
      c = pointColors[k];
    }
    gradient.addColorStopRGBA(k / 12, c[0], c[1], c[2], a);
  }

  cr.setLineWidth(size);
  cr.setSource(gradient);
  cr.newPath();
  cr.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 2; i++) {
    const p0 = i === 0 ? pts[i] : pts[i - 1];
    const p1 = pts[i];
    const p2 = [...pts[i + 1]];
    const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
    let ex = p2[0];
    let ey = p2[1];
    if (i === pts.length - 3) {
      ex = Math.round((p1[0] + p2[0] + p3[0]) / 3);
      ey = Math.round((p1[1] + p2[1] + p3[1]) / 3);
    }
    cr.curveTo(
      p1[0] + (p2[0] - p0[0]) * 0.167,
      p1[1] + (p2[1] - p0[1]) * 0.167,
      p2[0] - (p3[0] - p1[0]) * 0.167,
      p2[1] - (p3[1] - p1[1]) * 0.167,
      ex,
      ey,
    );
  }
  cr.stroke();
}

// 绘制一条完整轨迹（扩展本体，原始逐对描边算法，勿改动）。
// pts: [x, y, 时间戳, (r,g,b 仅 rainbow-time)]
// opts: {size, fadeLength, colorMode, color, alpha, now, pointColors}
export function drawTrail(cr, pts, opts) {
  const { size, fadeLength, colorMode, color, alpha, now } = opts;
  const pointColors = opts.pointColors;

  cr.setLineWidth(size);

  const getColors = (idx1, idx2) => {
    if (colorMode === "solid") return [color, color];
    if (colorMode === "rainbow-time") {
      // 模式切换瞬间可能存在切换前采集的旧点（无颜色分量），回退到纯色
      const c1 = pts[idx1];
      const c2 = pts[idx2];
      return [
        Number.isFinite(c1[3]) ? [c1[3], c1[4], c1[5]] : color,
        Number.isFinite(c2[3]) ? [c2[3], c2[4], c2[5]] : color,
      ];
    }
    return [pointColors[idx1], pointColors[idx2]];
  };

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
      ((now - p1[2]) / fadeLength) * 2,
      1 - (now - p1[2]) / fadeLength,
      getSpeedFactor(p1, p2, size),
    );
    const alpha_e =
      i === pts.length - 3
        ? 0
        : Math.min(
            ((now - p2[2]) / fadeLength) * 2,
            1 - (now - p2[2]) / fadeLength,
            getSpeedFactor(p2, p3, size),
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
