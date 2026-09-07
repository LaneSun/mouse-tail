// 轨迹渲染共享实现：extension 的实际绘制与 prefs 的预览调用同一算法，
// 保证预览所见即所得。全部从 extension.js 原实现原样迁移。
import Cairo from "gi://cairo";

import { colorAtStops } from "./profileEngine.js";

// 速度因子：移动越快轨迹越透明（600*size 像素/秒 为基准速度）
export function getSpeedFactor(p1, p2, size) {
  const dt = p2[2] - p1[2];
  if (dt <= 0) return Infinity;
  const dist = ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5;
  return dist / dt / ((600 * size) / 1000);
}

// 在方向变化超过 π/4 处切段，保证渐变方向与轨迹走向一致
export function splitLine(pts) {
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

// 绘制一条完整轨迹。pts: [x, y, 时间戳, (r,g,b 仅 rainbow-time)]
// opts: {size, fadeLength, renderMode, colorMode, color, alpha, now, pointColors}
// 调用方负责坐标平移（扩展按包围盒原点，预览直接用局部坐标）。
export function drawTrail(cr, pts, opts) {
  const { size, fadeLength, renderMode, colorMode, color, alpha, now } = opts;
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

  if (renderMode !== "precise") {
    const splits = splitLine(pts);
    for (let it = 0; it < splits.length; it++) {
      const [sidx, eidx] = splits[it];
      const p1 = pts[sidx];
      const p2 = pts[eidx];
      const i3 = (splits[it + 1] ?? splits[it])[1];
      const p3 = pts[i3];

      const alpha_s = Math.min(
        sidx === 0 ? 0 : 1,
        ((now - p1[2]) / fadeLength) * 2,
        1 - (now - p1[2]) / fadeLength,
        getSpeedFactor(p1, p2, size),
      );
      const alpha_e = Math.min(
        ((now - p2[2]) / fadeLength) * 2,
        it === splits.length - 1 ? 0 : 1,
        1 - (now - p2[2]) / fadeLength,
        getSpeedFactor(p2, p3, size),
      );

      const [c1, c2] = getColors(sidx, eidx);
      const gradient = new Cairo.LinearGradient(p1[0], p1[1], p2[0], p2[1]);
      gradient.addColorStopRGBA(0, c1[0], c1[1], c1[2], alpha_s * alpha);
      gradient.addColorStopRGBA(1, c2[0], c2[1], c2[2], alpha_e * alpha);
      cr.setSource(gradient);
      cr.newPath();
      cr.moveTo(p1[0], p1[1]);
      if (renderMode === "fast") {
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
}
