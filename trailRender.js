// Shared trail rendering used by both the extension's live drawing and
// the prefs preview, so the preview matches the real trail. Ported
// verbatim from the original extension.js implementation.
import Cairo from "gi://cairo";

import { colorAtStops } from "./styleEngine.js";

// Speed factor: faster motion makes the trail more transparent
// (600*size px/s is the reference speed)
export function getSpeedFactor(p1, p2, size) {
  const dt = p2[2] - p1[2];
  if (dt <= 0) return Infinity;
  const dist = ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5;
  return dist / dt / ((600 * size) / 1000);
}

// Per-point colors for rainbow-fixed / rainbow-ratio (distance
// accumulates from the newest point to the oldest)
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

// -- Preview trail synthesis --
// Builds a static "trail snapshot" for the prefs preview:
// - The waveform is exactly one standard sine period (starting at mid
//   height, bulging up over the crest, down through the trough, back to
//   mid height), split into a fixed 12 segments (13 sample points with
//   integer x);
// - Time window now = fadeDuration/3: sample ages decrease linearly from
//   fadeDuration/3 to 0, so the envelope peak of 2/3 (the authentic peak)
//   lands on the first sample point; the trail reads as a bright body
//   with a fading tip, matching the real steady-state look, and the
//   schedule is independent of line width and widget size;
// - One extra age=0 point is appended at the end so drawTrail's
//   last-3-points averaging only affects the invisible tip.
// Returns { pts: [x, y, ts], now }; rainbow colors are embedded by the caller.
export function synthPreviewTrail(w, h0, y0, lineWidth, fadeDuration) {
  const fl = Math.max(1, fadeDuration);
  const half = h0 / 2;
  const A = Math.max(4, Math.min(18, half - lineWidth / 2 - 6));
  const margin = 14;
  const wl0 = Math.max(1, w - 2 * margin);
  const N = 12; // fixed 12 segments
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

// -- Preview-only drawing: one gradient stroke, no seams --
// The preview is a single sine period spanning the canvas, and both the
// fade envelope and rainbow colors vary linearly along x between sample
// points. Stroking the whole Catmull-Rom path once with a single
// x-axis LinearGradient holding all sample stops reproduces drawTrail's
// per-segment gradient look exactly. A single stroke has no butt caps
// at joins, so the sequential-alpha compositing error (the ~1px light
// seam on slanted caps of per-pair strokes) cannot occur; clean at any
// opacity. Preview only; the extension itself still uses drawTrail's
// original per-pair stroking.
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

// Draws one full trail (extension core; original per-pair stroking
// algorithm; do not modify).
// pts: [x, y, timestamp, (r,g,b for rainbow-time only)]
// opts: {size, fadeLength, colorMode, color, alpha, now, pointColors}
export function drawTrail(cr, pts, opts) {
  const { size, fadeLength, colorMode, color, alpha, now } = opts;
  const pointColors = opts.pointColors;

  cr.setLineWidth(size);

  const getColors = (idx1, idx2) => {
    if (colorMode === "solid") return [color, color];
    if (colorMode === "rainbow-time") {
      // Right after a mode switch, old points collected before the switch
      // may lack the color components; fall back to the solid color
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
