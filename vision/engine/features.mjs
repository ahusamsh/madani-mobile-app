// Pure-JS ORB-like features: FAST-9 corners, intensity-centroid orientation,
// rotated BRIEF (256 bit) descriptors over an image pyramid, Hamming matching
// and a RANSAC homography. No WASM/CDN dependency, deterministic output.
import { boxBlur, resize } from './image.mjs';
import { project } from '../recognition-core.mjs';

const CIRCLE = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];
const PATCH_R = 13, BORDER = PATCH_R + 3, WORDS = 8, ANGLE_BINS = 32;

function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Fixed, seeded BRIEF sampling pattern (identical for reference and live frames).
const PATTERN = (() => {
  const rnd = mulberry32(0x5eed1e55), gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pt = () => { for (;;) { const x = gauss() * 5.2, y = gauss() * 5.2; if (x * x + y * y <= (PATCH_R - 1) ** 2) return [x, y]; } };
  return Array.from({ length: 256 }, () => [...pt(), ...pt()]);
})();
const ROTATED = Array.from({ length: ANGLE_BINS }, (_, b) => {
  const a = (b / ANGLE_BINS) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a), r = new Int8Array(1024);
  PATTERN.forEach(([x1, y1, x2, y2], i) => {
    r[i * 4] = Math.round(c * x1 - s * y1); r[i * 4 + 1] = Math.round(s * x1 + c * y1);
    r[i * 4 + 2] = Math.round(c * x2 - s * y2); r[i * 4 + 3] = Math.round(s * x2 + c * y2);
  });
  return r;
});

export function popcount32(v) { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24); }
export function hamming(a, ai, b, bi) { let s = 0; for (let k = 0; k < WORDS; k++) s += popcount32(a[ai + k] ^ b[bi + k]); return s; }

/** FAST-9 corners with 3x3 non-max suppression and grid bucketing for spatial spread. */
export function fastCorners(img, { threshold = 14, maxCorners = 500, grid = 8 } = {}) {
  const { w, h, d } = img, score = new Float32Array(w * h), offs = CIRCLE.map(([x, y]) => y * w + x);
  for (let y = BORDER; y < h - BORDER; y++) for (let x = BORDER; x < w - BORDER; x++) {
    const k = y * w + x, p = d[k], hi = p + threshold, lo = p - threshold;
    // quick rejection on compass points
    let nb = 0, nd = 0;
    for (const q of [0, 4, 8, 12]) { const v = d[k + offs[q]]; if (v > hi) nb++; else if (v < lo) nd++; }
    if (nb < 2 && nd < 2) continue;
    let run = 0, best = 0, sign = 0;
    for (let i = 0; i < 25; i++) {
      const v = d[k + offs[i & 15]], s = v > hi ? 1 : v < lo ? -1 : 0;
      if (s !== 0 && s === sign) run++; else { run = s ? 1 : 0; sign = s; }
      if (run > best) best = run;
    }
    if (best < 9) continue;
    let sc = 0; for (const o of offs) sc += Math.abs(d[k + o] - p);
    score[k] = sc;
  }
  const cells = Array.from({ length: grid * grid }, () => []), cw = w / grid, ch = h / grid;
  for (let y = BORDER; y < h - BORDER; y++) for (let x = BORDER; x < w - BORDER; x++) {
    const k = y * w + x, s = score[k];
    if (!s || s < score[k - 1] || s < score[k + 1] || s < score[k - w] || s < score[k + w] || s < score[k - w - 1] || s < score[k - w + 1] || s < score[k + w - 1] || s < score[k + w + 1]) continue;
    cells[Math.min(grid - 1, Math.floor(y / ch)) * grid + Math.min(grid - 1, Math.floor(x / cw))].push({ x, y, s });
  }
  const per = Math.ceil(maxCorners / (grid * grid)) * 2, out = [];
  for (const c of cells) { c.sort((a, b) => b.s - a.s); out.push(...c.slice(0, per)); }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, maxCorners);
}

function orientation(img, x, y) {
  const { w, d } = img; let m01 = 0, m10 = 0;
  for (let dy = -7; dy <= 7; dy++) { const r = Math.floor(Math.sqrt(49 - dy * dy)); for (let dx = -r; dx <= r; dx++) { const v = d[(y + dy) * w + x + dx]; m10 += dx * v; m01 += dy * v; } }
  return Math.atan2(m01, m10);
}

/** Detect and describe features over a pyramid. Coordinates are returned in the input image frame. */
export function computeFeatures(img, { levels = 3, scaleStep = 1.5, maxFeatures = 600, threshold = 14 } = {}) {
  const xs = [], ys = [], ang = [], lev = [], descs = [];
  let cur = img, scale = 1;
  for (let l = 0; l < levels; l++) {
    if (l > 0) { scale *= scaleStep; cur = resize(img, img.w / scale, img.h / scale); }
    if (cur.w < 2 * BORDER + 8 || cur.h < 2 * BORDER + 8) break;
    const smooth = boxBlur(cur, 2), share = Math.round(maxFeatures * (l === 0 ? 0.45 : 0.55 / (levels - 1)));
    for (const c of fastCorners(cur, { threshold, maxCorners: share })) {
      const a = orientation(smooth, c.x, c.y), bin = ((Math.round((a / (2 * Math.PI)) * ANGLE_BINS) % ANGLE_BINS) + ANGLE_BINS) % ANGLE_BINS;
      const pat = ROTATED[bin], desc = new Uint32Array(WORDS), { w, d } = smooth, base = c.y * w + c.x;
      for (let i = 0; i < 256; i++) if (d[base + pat[i * 4 + 1] * w + pat[i * 4]] < d[base + pat[i * 4 + 3] * w + pat[i * 4 + 2]]) desc[i >> 5] |= 1 << (i & 31);
      xs.push((c.x + 0.5) * scale - 0.5); ys.push((c.y + 0.5) * scale - 0.5); ang.push(a); lev.push(l); descs.push(desc);
    }
  }
  const desc = new Uint32Array(descs.length * WORDS); descs.forEach((v, i) => desc.set(v, i * WORDS));
  return { n: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), angle: Float32Array.from(ang), level: Uint8Array.from(lev), desc, w: img.w, h: img.h };
}

/** Lowe ratio-test matches from feature set A (query) to B (train). */
export function matchFeatures(A, B, { ratio = 0.8, maxDistance = 72 } = {}) {
  const out = [];
  for (let i = 0; i < A.n; i++) {
    let b1 = 1e9, b2 = 1e9, j1 = -1;
    for (let j = 0; j < B.n; j++) {
      const dd = hamming(A.desc, i * WORDS, B.desc, j * WORDS);
      if (dd < b1) { b2 = b1; b1 = dd; j1 = j; } else if (dd < b2) b2 = dd;
    }
    if (j1 >= 0 && b1 <= maxDistance && b1 < ratio * b2) out.push([i, j1, b1]);
  }
  return out;
}

// ---------- homography ----------
function solve(A, b) { // Gaussian elimination with partial pivoting, n x n
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x.every(Number.isFinite) ? x : null;
}
function normalizer(pts) {
  let cx = 0, cy = 0; for (const p of pts) { cx += p.x; cy += p.y; } cx /= pts.length; cy /= pts.length;
  let md = 0; for (const p of pts) md += Math.hypot(p.x - cx, p.y - cy); md = md / pts.length || 1;
  const s = Math.SQRT2 / md; return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], s, cx, cy };
}
const mul3 = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };

/** Least-squares DLT (h33 = 1) on normalized points; src -> dst. */
export function fitHomography(src, dst) {
  if (src.length < 4) return null;
  const ns = normalizer(src), nd = normalizer(dst), AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  for (let k = 0; k < src.length; k++) {
    const x = ns.s * (src[k].x - ns.cx), y = ns.s * (src[k].y - ns.cy), u = nd.s * (dst[k].x - nd.cx), v = nd.s * (dst[k].y - nd.cy);
    for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]]) {
      for (let i = 0; i < 8; i++) { Atb[i] += row[i] * rhs; for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]; }
    }
  }
  const h = solve(AtA, Atb); if (!h) return null;
  const Hn = [...h, 1], Tdi = [1 / nd.s, 0, nd.cx, 0, 1 / nd.s, nd.cy, 0, 0, 1], H = mul3(Tdi, mul3(Hn, ns.T));
  return H[8] && Number.isFinite(H[8]) ? H.map(v => v / H[8]) : null;
}

/** Reject physically implausible page registrations (mirrored, collapsed, extreme perspective). */
export function plausibleHomography(H, w, h) {
  if (!H) return false;
  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].map(p => project(H, p));
  if (corners.some(p => !p)) return false;
  let area = 0, sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false; // non-convex
    area += a.x * b.y - b.x * a.y;
  }
  const ratio = Math.abs(area / 2) / (w * h);
  return sign > 0 && ratio > 0.02 && ratio < 60;
}

/** RANSAC homography from matched point pairs. */
export function ransacHomography(src, dst, { threshold = 4, iterations = 1500, seed = 7, minInliers = 8 } = {}) {
  const n = src.length; if (n < 4) return null;
  const rnd = mulberry32(seed), t2 = threshold * threshold;
  let best = null, bestCount = 0;
  const count = H => { const mask = new Uint8Array(n); let c = 0; for (let k = 0; k < n; k++) { const p = project(H, src[k]); if (p && (p.x - dst[k].x) ** 2 + (p.y - dst[k].y) ** 2 < t2) { mask[k] = 1; c++; } } return { mask, c }; };
  let iters = iterations;
  for (let it = 0; it < iters; it++) {
    const idx = new Set(); while (idx.size < 4) idx.add(Math.floor(rnd() * n));
    const s = [...idx].map(i => src[i]), d = [...idx].map(i => dst[i]);
    const H = fitHomography(s, d); if (!H) continue;
    const { mask, c } = count(H);
    if (c > bestCount) {
      bestCount = c; best = { H, mask };
      const w = c / n; iters = Math.min(iterations, Math.ceil(Math.log(0.005) / Math.log(Math.max(1e-9, 1 - w ** 4))) + 10);
    }
  }
  if (!best || bestCount < minInliers) return null;
  for (let r = 0; r < 2; r++) { // refine on inliers
    const s = [], d = []; for (let k = 0; k < n; k++) if (best.mask[k]) { s.push(src[k]); d.push(dst[k]); }
    const H = fitHomography(s, d); if (!H) break;
    const res = count(H); if (res.c < bestCount) break; best = { H, mask: res.mask }; bestCount = res.c;
  }
  return { H: best.H, mask: best.mask, inliers: bestCount };
}

// ---------- multi-index hashing over all reference pages ----------
export class HammingLSH {
  constructor({ tables = 10, bits = 13, seed = 99, commonDistance = 40, commonRadius = 14 } = {}) {
    const rnd = mulberry32(seed);
    this.keys = Array.from({ length: tables }, () => Array.from({ length: bits }, () => Math.floor(rnd() * 256)));
    this.buckets = this.keys.map(() => new Map());
    this.cap = 4096; this.n = 0; this.alloc(this.cap);
    Object.assign(this, { commonDistance, commonRadius });
    this.offsets = new Map();
  }
  alloc(cap) {
    const grow = (A, T, k = 1) => { const B = new T(cap * k); if (A) B.set(A); return B; };
    this.desc = grow(this.desc, Uint32Array, WORDS); this.owner = grow(this.owner, Int32Array); this.local = grow(this.local, Int32Array);
    this.x = grow(this.x, Float32Array); this.y = grow(this.y, Float32Array); this.common = grow(this.common, Uint16Array); this.stamp = grow(this.stamp, Int32Array); this.cap = cap;
  }
  key(desc, off, t) { let k = 0; for (const b of this.keys[t]) k = (k << 1) | ((desc[off + (b >> 5)] >>> (b & 31)) & 1); return k; }
  /**
   * Adds a page's features. Features that also occur on OTHER pages at (nearly) the same page position
   * (frames, banners, grid lines, repeated letter cells) are counted as common: they cannot tell pages apart.
   */
  add(owner, F) {
    if (this.n + F.n > this.cap) this.alloc(Math.max(this.cap * 2, this.n + F.n));
    if (!Number.isInteger(owner) || owner < 0) throw new TypeError('page ids must be non-negative integers');
    this.maxOwner = Math.max(this.maxOwner ?? 0, owner);
    this.offsets.set(owner, this.n);
    let mark = (this.mark ?? 0);
    for (let i = 0; i < F.n; i++) {
      const g = this.n++; this.owner[g] = owner; this.local[g] = i; this.desc.set(F.desc.subarray(i * WORDS, (i + 1) * WORDS), g * WORDS);
      this.x[g] = F.x[i]; this.y[g] = F.y[i]; this.common[g] = 0; mark++;
      const others = [];
      for (let t = 0; t < this.keys.length; t++) {
        const k = this.key(F.desc, i * WORDS, t), b = this.buckets[t].get(k);
        if (b) for (const o of b) {
          if (this.stamp[o] === mark || this.owner[o] === owner) continue; this.stamp[o] = mark;
          if (Math.abs(this.x[o] - F.x[i]) > this.commonRadius || Math.abs(this.y[o] - F.y[i]) > this.commonRadius) continue;
          if (hamming(F.desc, i * WORDS, this.desc, o * WORDS) <= this.commonDistance) { if (this.common[o] < 65000) this.common[o]++; if (!others.includes(this.owner[o])) others.push(this.owner[o]); }
        }
        if (b) b.push(g); else this.buckets[t].set(k, [g]);
      }
      this.common[g] += others.length;
    }
    this.mark = mark;
  }
  /** Candidate correspondences for every page at once: per page, the best reference feature for each query. */
  matchAll(F, { maxDistance = 56, slack = 6, maxBucket = 400 } = {}) {
    const per = new Map(); let mark = (this.mark ?? 0);
    const maxOwner = this.maxOwner ?? 0, bestD = new Int32Array(maxOwner + 1), bestG = new Int32Array(maxOwner + 1), ostamp = new Int32Array(maxOwner + 1), touched = [];
    for (let i = 0; i < F.n; i++) {
      mark++; touched.length = 0; let top = 999;
      for (let t = 0; t < this.keys.length; t++) {
        const b = this.buckets[t].get(this.key(F.desc, i * WORDS, t)); if (!b || b.length > maxBucket) continue; // huge buckets = featureless patterns
        for (let q = 0; q < b.length; q++) {
          const g = b[q]; if (this.stamp[g] === mark) continue; this.stamp[g] = mark;
          const d = hamming(F.desc, i * WORDS, this.desc, g * WORDS); if (d > maxDistance) continue;
          const o = this.owner[g];
          if (ostamp[o] !== mark) { ostamp[o] = mark; bestD[o] = d; bestG[o] = g; touched.push(o); } else if (d < bestD[o]) { bestD[o] = d; bestG[o] = g; }
          if (d < top) top = d;
        }
      }
      // a query only supports pages where it is (nearly) as good as its best page anywhere in the book
      for (const o of touched) { if (bestD[o] > top + slack) continue; const g = bestG[o], m = [i, this.local[g], bestD[o], this.common[g]], l = per.get(o); if (l) l.push(m); else per.set(o, [m]); }
    }
    this.mark = mark;
    return per;
  }
}
