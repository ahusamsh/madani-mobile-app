// SYNTHETIC test-frame generator. Everything produced here is simulated:
// results obtained with it are NOT real-camera validation.
import { project, invertHomography } from '../recognition-core.mjs';
import { fitHomography } from './features.mjs';

export function rng(seed = 1) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Procedural "book page": rows of glyph-like stroke clusters. Returns gray image + word boxes. */
export function proceduralPage({ w = 480, h = 680, seed = 3, rows = 9, perRow = 4 } = {}) {
  const r = rng(seed), d = new Float32Array(w * h).fill(238), words = [];
  const stroke = (x0, y0, x1, y1, th) => {
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - th)), maxx = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + th));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - th)), maxy = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + th));
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2)), dist = Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
      if (dist < th) d[y * w + x] = Math.min(d[y * w + x], 25 + 40 * (dist / th));
    }
  };
  const top = h * 0.08, rowH = (h * 0.86) / rows;
  for (let row = 0; row < rows; row++) {
    const cellW = (w * 0.86) / perRow;
    for (let c = 0; c < perRow; c++) {
      const bw = cellW * (0.55 + 0.35 * r()), bh = rowH * 0.55, bx = w * 0.07 + c * cellW + (cellW - bw) / 2, by = top + row * rowH + rowH * 0.2;
      const n = 3 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const x0 = bx + r() * bw, y0 = by + r() * bh, a = r() * Math.PI * 2, len = bh * (0.25 + 0.5 * r());
        stroke(x0, y0, Math.max(bx, Math.min(bx + bw, x0 + Math.cos(a) * len)), Math.max(by, Math.min(by + bh, y0 + Math.sin(a) * len)), 1.6 + r() * 1.8);
      }
      for (let k = 0; k < 2; k++) { const cx = bx + r() * bw, cy = by - 4 + r() * 3; stroke(cx - 3, cy, cx + 3, cy - 1, 1.3); } // diacritic-like marks
      words.push({ id: `w${row}-${c}`, text: `كلمة${row}-${c}`, box: [bx / w, by / h, bw / w, bh / h], row, col: c });
    }
  }
  return { gray: { w, h, d }, words };
}

/** Homography that maps reference-page px to frame px from a camera "pose". */
export function poseHomography(ref, { frameW = 480, frameH = 360, center = [0.5, 0.5], pageWidthInFrame = 1.1, rotationDeg = 0, tiltX = 0, tiltY = 0 } = {}) {
  const cx = center[0] * ref.w, cy = center[1] * ref.h, s = (pageWidthInFrame * frameW) / ref.w, a = (rotationDeg * Math.PI) / 180;
  const corners = [[0, 0], [ref.w, 0], [ref.w, ref.h], [0, ref.h]];
  const dst = corners.map(([x, y]) => {
    let u = (x - cx) * s, v = (y - cy) * s;
    // perspective foreshortening: points farther "up" shrink (tiltX) / farther right shrink (tiltY)
    const k = 1 + tiltX * (v / frameH) + tiltY * (u / frameW); u /= k; v /= k;
    return { x: frameW / 2 + u * Math.cos(a) - v * Math.sin(a), y: frameH / 2 + u * Math.sin(a) + v * Math.cos(a) };
  });
  return fitHomography(corners.map(([x, y]) => ({ x, y })), dst);
}

/**
 * Render a camera frame (RGBA) of the reference page.
 * opts.light: {gain, gradient:[gx,gy], shadow:{x,y,r,depth}, glare:{x,y,r}}; noise sigma; blur passes.
 * pointer: {type:'pen'|'pencil'|'finger', tipPage:{x,y} (ref px), angleDeg (direction from tip towards the hand, frame space),
 *           hand:boolean, castShadow:boolean, mmPerRefPx}
 */
export function renderFrame(ref, H, { frameW = 480, frameH = 360, light = {}, noise = 3, seed = 5, pointer = null, background = [70, 62, 55] } = {}) {
  const r = rng(seed), Hinv = invertHomography(H), out = new Uint8ClampedArray(frameW * frameH * 4);
  const gain = light.gain ?? 1, [gx, gy] = light.gradient ?? [0, 0];
  const lum = new Float32Array(frameW * frameH);
  for (let y = 0; y < frameH; y++) for (let x = 0; x < frameW; x++) {
    const p = project(Hinv, { x, y }); let v;
    if (p && p.x >= 0 && p.y >= 0 && p.x <= ref.w - 1 && p.y <= ref.h - 1) {
      const x0 = Math.min(ref.w - 2, Math.floor(p.x)), y0 = Math.min(ref.h - 2, Math.floor(p.y)), fx = p.x - x0, fy = p.y - y0, i = y0 * ref.w + x0, d = ref.d;
      v = (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + ref.w] * (1 - fx) + d[i + ref.w + 1] * fx) * fy;
    } else v = -1;
    lum[y * frameW + x] = v;
  }
  const shade = (x, y) => {
    let g = gain * (1 + gx * (x / frameW - 0.5) + gy * (y / frameH - 0.5));
    if (light.shadow) { const { x: sx, y: sy, r: sr, depth } = light.shadow; const dd = Math.hypot(x - sx, y - sy) / sr; g *= 1 - depth * Math.max(0, Math.min(1, 1.5 - dd)); }
    return g;
  };
  for (let y = 0; y < frameH; y++) for (let x = 0; x < frameW; x++) {
    const k = y * frameW + x, v = lum[k], g = shade(x, y);
    let rgb = v < 0 ? background.map(c => c * (0.8 + 0.2 * g)) : [v * g, v * g * 0.99, v * g * 0.95];
    if (light.glare && v >= 0) { const dd = Math.hypot(x - light.glare.x, y - light.glare.y) / light.glare.r; if (dd < 1) rgb = rgb.map(c => c + (255 - c) * (1 - dd) * 0.85); }
    out.set([rgb[0], rgb[1], rgb[2], 255], k * 4);
  }
  let tipFrame = null;
  if (pointer) tipFrame = drawPointer(out, frameW, frameH, H, ref, pointer, r);
  if (noise > 0) for (let i = 0; i < out.length; i += 4) { const n = (r() + r() + r() - 1.5) * noise * 2; out[i] += n; out[i + 1] += n; out[i + 2] += n; }
  return { rgba: out, width: frameW, height: frameH, tipFrame };
}

function localScale(H, p) { // frame px per ref px around p
  const a = project(H, p), b = project(H, { x: p.x + 1, y: p.y }), c = project(H, { x: p.x, y: p.y + 1 });
  return Math.sqrt(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)));
}

function drawPointer(out, W, Hh, H, ref, pt, r) {
  const tip = project(H, pt.tipPage), mm = (1 / (pt.mmPerRefPx ?? 170 / ref.w)) * localScale(H, pt.tipPage); // frame px per mm
  const a = ((pt.angleDeg ?? 90) * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
  const type = pt.type;
  const half = t => { // half width (mm) at distance t (mm) from tip along axis
    if (type === 'finger') { const R = 7.5; return t < R ? Math.sqrt(Math.max(0, R * R - (R - t) ** 2)) : R + Math.min(1.5, (t - R) * 0.03); }
    const cone = type === 'pencil' ? 14 : 11, maxHalf = type === 'pencil' ? 3.8 : 4.4; return t < cone ? 0.35 + (t / cone) * (maxHalf - 0.35) : maxHalf;
  };
  const color = t => {
    if (type === 'finger') return [222, 168, 140];
    if (type === 'pencil') return t < 3 ? [45, 45, 48] : t < 14 ? [214, 178, 128] : [230, 190, 40];
    return t < 2 ? [60, 60, 60] : pt.color ?? [30, 34, 60];
  };
  const handStart = (pt.handAtMm ?? 70);
  const shadowOff = pt.castShadow ? { x: 3 * mm, y: 2 * mm } : null;
  const covered = (x, y) => {
    const dx = x - tip.x, dy = y - tip.y, t = (dx * ux + dy * uy) / mm, perp = Math.abs(-dx * uy + dy * ux) / mm;
    if (t < -0.2) return null;
    if (perp <= half(Math.max(0, t))) return { t, perp, part: 'pointer' };
    if (pt.hand && type !== 'finger' && t > handStart) { const ht = t - handStart; if (perp < Math.min(45, 18 + ht * 0.8)) return { t, perp, part: 'hand' }; }
    if (pt.hand && type === 'finger' && t > 60) { const ht = t - 60; if (perp < Math.min(50, 10 + ht * 0.9)) return { t, perp, part: 'hand' }; }
    return null;
  };
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4, c = covered(x, y);
    if (c) {
      const col = c.part === 'hand' ? [215, 160, 132] : color(c.t), edge = 1 - 0.25 * Math.min(1, c.perp / Math.max(0.5, half(Math.max(0, c.t))));
      out[k] = col[0] * edge; out[k + 1] = col[1] * edge; out[k + 2] = col[2] * edge;
    } else if (shadowOff && covered(x - shadowOff.x, y - shadowOff.y)) { out[k] *= 0.82; out[k + 1] *= 0.82; out[k + 2] *= 0.84; }
  }
  return tip;
}
