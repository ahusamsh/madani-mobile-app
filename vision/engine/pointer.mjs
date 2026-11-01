// Image-evidence pointer detection (finger or pen/pencil), independent of hand landmarks.
//
// Idea: once the page is registered, we know what the camera *should* see (the reference page
// warped into the frame). Anything that occludes the page and enters from outside it
// (frame border or off-page area) is a pointer candidate. The tip is the geodesically farthest
// point of that occluder from where it enters; pen vs finger is decided from the physical width
// (mm, via the registration scale) near the tip plus skin chroma. Ambiguous cases are reported
// as 'uncertain', never guessed.
import { resize, boxBlur, warp, minFilter, erodeMask, dilateMask } from './image.mjs';
import { project, invertHomography } from '../recognition-core.mjs';

export const POINTER_DEFAULTS = {
  pageWidthMm: 170,          // physical width of the printed page (PDF: 481.9pt = 170mm)
  darkRatio: 0.62,           // live/expected below this = opaque dark occluder (shadows are ~0.7-0.85)
  chromaDelta: 13,           // skin / coloured pen chroma departure from local paper chroma
  textureLoss: 0.35,         // live local contrast / expected local contrast below this over print
  minAreaMm2: 40,            // smaller blobs are specks/noise
  maxPageCover: 0.55,        // a larger occluder means wrong registration or a turned page
  penMaxWidthMm: 9,          // width 8mm behind the tip
  fingerMinWidthMm: 9.5,
  minVisibleLengthMm: 22,       // shorter visible pointers give unreliable axis/tip estimates
  tileMm: 16,
};

const skin = (r, g, b) => { // YCbCr skin box (broad, lighting tolerant)
  const y = 0.299 * r + 0.587 * g + 0.114 * b, cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
  return y > 50 && cr > 136 && cr < 180 && cb > 80 && cb < 130 && r > b;
};

function halfRGB(rgba, W, H, w, h) { // area-average to working size -> {cr, cb, skin}
  const sx = W / w, sy = H / h, cr = new Float32Array(w * h), cb = new Float32Array(w * h), sk = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.min(H, Math.floor((y + 1) * sy)); yy++) for (let xx = Math.floor(x * sx); xx < Math.min(W, Math.floor((x + 1) * sx)); xx++) { const k = (yy * W + xx) * 4; r += rgba[k]; g += rgba[k + 1]; b += rgba[k + 2]; n++; }
    r /= n || 1; g /= n || 1; b /= n || 1; const k = y * w + x;
    cr[k] = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b; cb[k] = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b; sk[k] = skin(r, g, b) ? 1 : 0;
  }
  return { cr, cb, skin: sk };
}

function tileField(w, h, tile, fn) { // robust per-tile estimate, NaN-filled then smoothed, bilinear lookup
  const tx = Math.ceil(w / tile), ty = Math.ceil(h / tile), f = new Float32Array(tx * ty).fill(NaN);
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) f[j * tx + i] = fn(i * tile, j * tile, Math.min(w, (i + 1) * tile), Math.min(h, (j + 1) * tile));
  const vals = [...f].filter(Number.isFinite).sort((a, b) => a - b), med = vals.length ? vals[vals.length >> 1] : NaN;
  const g = f.map((v, k) => { if (Number.isFinite(v)) return v; const i = k % tx, j = (k / tx) | 0, nb = []; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v2 = f[(j + dj) * tx + i + di]; if (i + di >= 0 && i + di < tx && j + dj >= 0 && j + dj < ty && Number.isFinite(v2)) nb.push(v2); } return nb.length ? nb.reduce((a, b) => a + b) / nb.length : med; });
  const sm = g.map((_, k) => { const i = k % tx, j = (k / tx) | 0, nb = []; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (i + di >= 0 && i + di < tx && j + dj >= 0 && j + dj < ty && Number.isFinite(g[(j + dj) * tx + i + di])) nb.push(g[(j + dj) * tx + i + di]); nb.sort((a, b) => a - b); return nb.length ? nb[nb.length >> 1] : med; });
  return (x, y) => {
    const fx = Math.max(0, Math.min(tx - 1, x / tile - 0.5)), fy = Math.max(0, Math.min(ty - 1, y / tile - 0.5)), i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(tx - 1, i0 + 1), j1 = Math.min(ty - 1, j0 + 1), a = fx - i0, b = fy - j0;
    return (sm[j0 * tx + i0] * (1 - a) + sm[j0 * tx + i1] * a) * (1 - b) + (sm[j1 * tx + i0] * (1 - a) + sm[j1 * tx + i1] * a) * b;
  };
}
const percentile = (arr, p) => { if (!arr.length) return NaN; arr.sort((a, b) => a - b); return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]; };

/** Frame-pixels per reference-pixel at point p (ref coords) under homography H. */
export function localScale(H, p) {
  const a = project(H, p), b = project(H, { x: p.x + 1, y: p.y }), c = project(H, { x: p.x, y: p.y + 1 });
  if (!a || !b || !c) return NaN;
  return Math.sqrt(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)));
}

/**
 * @param live   gray frame {w,h,d}
 * @param ref    gray reference page {w,h,d}
 * @param H      registration ref->frame (3x3 row-major, 9 numbers)
 * @param rgba   optional RGBA bytes of the frame (enables skin/chroma evidence)
 */
export function detectPointer(live, ref, H, { rgba = null, work = 2, ...o } = {}) {
  const opt = { ...POINTER_DEFAULTS, ...o };
  const w = Math.round(live.w / work), h = Math.round(live.h / work), S = [1 / work, 0, 0, 0, 1 / work, 0, 0, 0, 1];
  const Hw = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => S[r * 3] * H[c] + S[r * 3 + 1] * H[3 + c] + S[r * 3 + 2] * H[6 + c]));
  const Hinv = invertHomography(Hw); if (!Hinv) return { type: null, reason: 'no-registration' };
  const center = { x: ref.w / 2, y: ref.h / 2 }, sc = localScale(Hw, center); // work px per ref px
  if (!(sc > 0)) return { type: null, reason: 'no-registration' };
  const mmPerRef = opt.pageWidthMm / ref.w, pxPerMm = sc / mmPerRef;
  const refBlur = boxBlur(ref, Math.max(0, Math.round(0.5 / sc - 0.5)));
  const { img: E0, valid } = warp(refBlur, Hinv, w, h);
  const E = minFilter(E0, 1), L = boxBlur(resize(live, w, h), 1), N = w * h;
  const col = rgba ? halfRGB(rgba, live.w, live.h, w, h) : null;
  const tile = Math.max(8, Math.round(opt.tileMm * pxPerMm));
  // illumination gain (paper level ratio) and paper chroma per tile
  const gain = tileField(w, h, tile, (x0, y0, x1, y1) => { const a = [], b = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * w + x; if (valid[k] && E0.d[k] > 140) { a.push(L.d[k]); b.push(E0.d[k]); } } return a.length > 12 ? percentile(a, 0.85) / percentile(b, 0.85) : NaN; });
  const crF = col && tileField(w, h, tile, (x0, y0, x1, y1) => { const a = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * w + x; if (valid[k] && E.d[k] > 150) a.push(col.cr[k]); } return a.length > 12 ? percentile(a, 0.5) : NaN; });
  const cbF = col && tileField(w, h, tile, (x0, y0, x1, y1) => { const a = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * w + x; if (valid[k] && E.d[k] > 150) a.push(col.cb[k]); } return a.length > 12 ? percentile(a, 0.5) : NaN; });
  // local contrast for the texture-loss cue
  const sq = img => ({ w, h, d: img.d.map(v => v * v) }), r2 = 2;
  const mE = boxBlur({ w, h, d: E0.d.map((v, k) => (valid[k] ? v : 0)) }, r2), qE = boxBlur(sq({ d: E0.d.map((v, k) => (valid[k] ? v : 0)) }), r2), mL = boxBlur(L, r2), qL = boxBlur(sq(L), r2);
  let fg = new Uint8Array(N), validCount = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x; if (!valid[k]) continue; validCount++;
    const g = gain(x, y), exp = Math.max(12, g * E.d[k]), ratio = L.d[k] / exp;
    let on = ratio < opt.darkRatio;
    if (!on && col && E.d[k] > 150) on = Math.abs(col.cr[k] - crF(x, y)) + Math.abs(col.cb[k] - cbF(x, y)) > opt.chromaDelta;
    if (!on) { const sE = Math.sqrt(Math.max(0, qE.d[k] - mE.d[k] ** 2)) * g, sL = Math.sqrt(Math.max(0, qL.d[k] - mL.d[k] ** 2)); on = sE > 28 && sL < opt.textureLoss * sE; }
    fg[k] = on ? 1 : 0;
  }
  const raw = fg;
  fg = dilateMask(erodeMask(fg, w, h, 1), w, h, 1);   // open: remove specks
  fg = erodeMask(dilateMask(fg, w, h, 2), w, h, 2);   // close: bridge pen/finger over print
  for (let k = 0; k < N; k++) if (!valid[k]) fg[k] = 0;
  const debug = { mask: fg, w, h, work, pxPerMm };
  let fgCount = 0; for (let k = 0; k < N; k++) fgCount += fg[k];
  if (validCount < N * 0.05) return { type: null, reason: 'page-not-in-view', debug };
  if (fgCount > validCount * opt.maxPageCover) return { type: null, reason: 'page-occluded-or-misregistered', debug };
  // components that enter from outside the visible page
  const label = new Int32Array(N).fill(-1), comps = [], q = new Int32Array(N);
  const boundary = k => { const x = k % w, y = (k / w) | 0; return x === 0 || y === 0 || x === w - 1 || y === h - 1 || !valid[k - 1] || !valid[k + 1] || !valid[k - w] || !valid[k + w]; };
  for (let s = 0; s < N; s++) {
    if (!fg[s] || label[s] >= 0) continue;
    let head = 0, tail = 0, area = 0, entry = []; q[tail++] = s; label[s] = comps.length;
    while (head < tail) {
      const k = q[head++]; area++; if (boundary(k)) entry.push(k);
      const x = k % w; for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) if (n >= 0 && n < N && fg[n] && label[n] < 0) { label[n] = comps.length; q[tail++] = n; }
    }
    comps.push({ id: comps.length, area, entry });
  }
  const minArea = opt.minAreaMm2 * pxPerMm * pxPerMm;
  const cands = comps.filter(c => c.area >= minArea && c.entry.length >= 2).sort((a, b) => b.area - a.area);
  if (!cands.length) return { type: null, reason: comps.some(c => c.area >= minArea) ? 'occluder-not-entering-from-outside' : 'no-pointer-evidence', debug };
  const c = cands[0];
  // geodesic distance from the entry pixels; tip = farthest point
  const dist = new Int32Array(N).fill(-1); let head = 0, tail = 0, far = 0;
  for (const k of c.entry) { dist[k] = 0; q[tail++] = k; }
  while (head < tail) { const k = q[head++], x = k % w; far = Math.max(far, dist[k]); for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) if (n >= 0 && n < N && label[n] === c.id && dist[n] < 0) { dist[n] = dist[k] + 1; q[tail++] = n; } }
  let tx = 0, ty = 0, tn = 0, ax = 0, ay = 0, an = 0, tipRegion = 0, tipSkin = 0;
  const backLo = far - Math.round(14 * pxPerMm), backHi = far - Math.round(6 * pxPerMm), skinR = far - Math.round(12 * pxPerMm);
  for (let k = 0; k < N; k++) {
    const dk = dist[k]; if (dk < 0) continue;
    const x = k % w, y = (k / w) | 0;
    if (dk >= far - 1) { tx += x; ty += y; tn++; }
    if (dk >= backLo && dk <= backHi) { ax += x; ay += y; an++; }
    if (dk >= skinR) { tipRegion++; if (col?.skin[k]) tipSkin++; }
  }
  tx /= tn; ty /= tn;
  if (!an) { ax = tx; ay = ty + 1; an = 1; }
  let ux = tx - ax / an, uy = ty - ay / an; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul; // axis pointing towards the tip
  { // principal axis of the last 25 mm of the occluder (robust to the metric bias), oriented to the tip
    const lo = far - Math.round(25 * pxPerMm); let mx = 0, my = 0, n = 0, sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < N; k++) if (dist[k] >= lo) { mx += k % w; my += (k / w) | 0; n++; }
    if (n > 10) { mx /= n; my /= n;
      for (let k = 0; k < N; k++) if (dist[k] >= lo) { const dx = (k % w) - mx, dy = ((k / w) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); let vx = Math.cos(th), vy = Math.sin(th);
      if (vx * (tx - mx) + vy * (ty - my) < 0) { vx = -vx; vy = -vy; }
      ux = vx; uy = vy; }
  }
  // 4-connected geodesic distance is Manhattan-biased towards diagonal corners: re-pick the tip as the
  // most advanced point along the axis within the tip segment, then follow the raw (unfiltered) mask
  // along the axis to recover thin pencil/pen points removed by the morphological opening.
  { const seg = far - Math.round(8 * pxPerMm); let best = -Infinity; const pts = [];
    for (let k = 0; k < N; k++) if (dist[k] >= seg) { const x = k % w, y = (k / w) | 0, pr = x * ux + y * uy; pts.push([x, y, pr]); if (pr > best) best = pr; }
    let sx = 0, sy = 0, sn = 0; for (const [x, y, pr] of pts) if (pr >= best - 1) { sx += x; sy += y; sn++; }
    if (sn) { tx = sx / sn; ty = sy / sn; }
    for (let s = 1; s <= Math.round(4 * pxPerMm); s++) {
      const x = Math.round(tx + ux), y = Math.round(ty + uy); if (x < 0 || y < 0 || x >= w || y >= h) break;
      let hit = false; for (const o of [0, 1, -1]) { const xx = Math.round(x - uy * o), yy = Math.round(y + ux * o); if (xx >= 0 && yy >= 0 && xx < w && yy < h && raw[yy * w + xx]) hit = true; }
      if (!hit) break; tx += ux; ty += uy;
    } }
  const widthAt = mm => { // perpendicular run length through the axis point mm behind the tip
    const px = tx - ux * mm * pxPerMm, py = ty - uy * mm * pxPerMm; let run = 0;
    for (const sgn of [1, -1]) for (let s = sgn > 0 ? 0 : 1; s < 80 * pxPerMm; s++) { const x = Math.round(px - uy * s * sgn), y = Math.round(py + ux * s * sgn); if (x < 0 || y < 0 || x >= w || y >= h) break; if (label[y * w + x] !== c.id) break; run++; }
    return run / pxPerMm;
  };
  { // a real tip has background beyond it along the axis; a shaft crossing the whole view (tip outside) does not
    let beyond = 0, n = 0;
    for (let mm = 3; mm <= 7; mm++) { const x = Math.round(tx + ux * mm * pxPerMm), y = Math.round(ty + uy * mm * pxPerMm); if (x < 0 || y < 0 || x >= w || y >= h) continue; n++; if (label[y * w + x] === c.id) beyond++; }
    if (n && beyond / n > 0.5) return { type: null, reason: 'no-clear-tip', debug };
  }
  const w8 = widthAt(8), w16 = widthAt(16), lengthMm = far / pxPerMm, skinFrac = col ? tipSkin / Math.max(1, tipRegion) : null;
  const tipFrame = { x: (tx + 0.5) * work - 0.5, y: (ty + 0.5) * work - 0.5 };
  const evidence = { widthMm8: +w8.toFixed(1), widthMm16: +w16.toFixed(1), visibleLengthMm: +lengthMm.toFixed(1), skinFraction: skinFrac === null ? null : +skinFrac.toFixed(2), areaPx: c.area, components: cands.length, method: 'reference-difference-occluder' };
  const onBorder = tx <= 1 || ty <= 1 || tx >= w - 2 || ty >= h - 2;
  if (onBorder) return { type: null, reason: 'tip-out-of-frame', tip: tipFrame, evidence, debug };
  if (lengthMm < opt.minVisibleLengthMm || !(w16 > 0)) return { type: 'uncertain', reason: 'pointer-too-short', tip: tipFrame, evidence, confidence: 0.3, debug };
  const clamp = v => Math.max(0, Math.min(1, v));
  const widthPen = clamp((opt.penMaxWidthMm + 1 - w8) / 3), widthFinger = clamp((w8 - opt.fingerMinWidthMm + 1) / 3);
  let penScore = widthPen, fingerScore = widthFinger;
  if (skinFrac !== null) { penScore = 0.65 * widthPen + 0.35 * (1 - clamp(skinFrac * 2)); fingerScore = 0.6 * widthFinger + 0.4 * clamp((skinFrac - 0.15) * 2); }
  // a pen keeps its width; a finger widens quickly from the rounded tip and stays wide
  if (w16 > 0 && w16 < opt.penMaxWidthMm + 1.5 && w8 <= opt.penMaxWidthMm) penScore = Math.min(1, penScore + 0.1);
  let type = 'uncertain', confidence = Math.max(penScore, fingerScore) * 0.5;
  if (penScore >= 0.7 && penScore - fingerScore >= 0.3) { type = 'pen'; confidence = penScore; }
  else if (fingerScore >= 0.7 && fingerScore - penScore >= 0.3) { type = 'finger'; confidence = fingerScore; }
  confidence = +Math.min(0.99, confidence * (cands.length > 2 ? 0.85 : 1)).toFixed(3);
  return { type, confidence, tip: tipFrame, axis: { x: ux, y: uy }, evidence, reason: type === 'uncertain' ? 'pointer-type-uncertain' : null, debug };
}
