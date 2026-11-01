// Dependency-free grayscale image utilities used by the camera engine.
// Images are {w, h, d} where d is a Float32Array (0..255) of length w*h.

export const makeImage = (w, h, d = new Float32Array(w * h)) => ({ w, h, d });

export function fromRGBA(rgba, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { w, h, d };
}

/** Summed-area table of size (w+1)*(h+1). */
export function integral(img) {
  const { w, h, d } = img, W = w + 1, s = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += d[y * w + x]; s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row; }
  }
  return s;
}

const rectSum = (s, W, x0, y0, x1, y1) => s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];

/** Box blur of radius r (window 2r+1), edge-clamped by window shrinking. */
export function boxBlur(img, r) {
  if (r <= 0) return { w: img.w, h: img.h, d: Float32Array.from(img.d) };
  const { w, h } = img, s = integral(img), W = w + 1, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = rectSum(s, W, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
    }
  }
  return { w, h, d: out };
}

/** Area-averaging resize (good for downscaling camera frames). */
export function resize(img, nw, nh) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  const { w, h } = img, out = new Float32Array(nw * nh), sx = w / nw, sy = h / nh;
  if (sx <= 1 && sy <= 1) {
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = sample(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, 255);
    return { w: nw, h: nh, d: out };
  }
  const s = integral(img), W = w + 1;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * sy)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * sx)));
      out[y * nw + x] = rectSum(s, W, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
    }
  }
  return { w: nw, h: nh, d: out };
}

/** Bilinear sample; returns `outside` when the point is off the image. */
export function sample(img, x, y, outside = NaN) {
  const { w, h, d } = img;
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return outside;
  const x0 = Math.min(w - 2, Math.floor(x)), y0 = Math.min(h - 2, Math.floor(y));
  if (x0 < 0 || y0 < 0) return d[Math.round(y) * w + Math.round(x)];
  const fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

/** Render `src` into a w*h canvas through homography Hinv (output pixel -> src pixel). */
export function warp(src, Hinv, w, h, outside = NaN) {
  const out = new Float32Array(w * h), valid = new Uint8Array(w * h);
  const [a, b, c, d, e, f, g, i, j] = Hinv;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const z = g * x + i * y + j;
      const v = Math.abs(z) < 1e-9 ? NaN : sample(src, (a * x + b * y + c) / z, (d * x + e * y + f) / z, NaN);
      const k = y * w + x;
      if (Number.isNaN(v)) out[k] = outside; else { out[k] = v; valid[k] = 1; }
    }
  }
  return { img: { w, h, d: out }, valid };
}

function rank1D(src, w, h, r, horizontal, pick) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = src[y * w + x];
    for (let k = -r; k <= r; k++) {
      const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = src[yy * w + xx];
      if (!Number.isNaN(v) && (Number.isNaN(m) || pick(v, m))) m = v;
    }
    out[y * w + x] = m;
  }
  return out;
}
/** Square min (erosion) / max (dilation) filters, NaN-aware. */
export const minFilter = (img, r) => ({ w: img.w, h: img.h, d: rank1D(rank1D(img.d, img.w, img.h, r, true, (a, b) => a < b), img.w, img.h, r, false, (a, b) => a < b) });
export const maxFilter = (img, r) => ({ w: img.w, h: img.h, d: rank1D(rank1D(img.d, img.w, img.h, r, true, (a, b) => a > b), img.w, img.h, r, false, (a, b) => a > b) });

/** Morphology on binary masks (Uint8Array). */
export function dilateMask(m, w, h, r) {
  const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = m[y * w + k];
    t[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = t[k * w + x];
    o[y * w + x] = v;
  }
  return o;
}
export function erodeMask(m, w, h, r) {
  const inv = m.map(v => (v ? 0 : 1)), d = dilateMask(inv, w, h, r);
  return d.map(v => (v ? 0 : 1));
}

/** Frame quality used to distinguish a weak camera from "no pointer". */
export function frameQuality(img) {
  const { w, h, d } = img;
  let s = 0, s2 = 0, lap = 0, lap2 = 0, n = 0;
  for (let i = 0; i < d.length; i++) { s += d[i]; s2 += d[i] * d[i]; }
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const k = y * w + x, v = 4 * d[k] - d[k - 1] - d[k + 1] - d[k - w] - d[k + w];
    lap += v; lap2 += v * v; n++;
  }
  const mean = s / d.length, std = Math.sqrt(Math.max(0, s2 / d.length - mean * mean));
  const sharpness = n ? lap2 / n - (lap / n) ** 2 : 0;
  let weak = null;
  if (mean < 28) weak = 'weak-camera-dark';
  else if (mean > 245 && std < 10) weak = 'weak-camera-overexposed';
  else if (std < 9) weak = 'weak-camera-low-contrast';
  else if (sharpness < 25) weak = 'weak-camera-blur';
  return { mean, std, sharpness, weak };
}
