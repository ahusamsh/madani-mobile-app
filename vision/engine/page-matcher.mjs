// Page identification from a partial camera view: LSH vote over all indexed
// pages, then geometric verification (RANSAC homography) of the best few.
import { computeFeatures, matchFeatures, ransacHomography, plausibleHomography, HammingLSH } from './features.mjs';
import { choosePage, project } from '../recognition-core.mjs';
import { resize, boxBlur, sample } from './image.mjs';
import { hamming } from './features.mjs';

const pairs = (m, live, ref) => [m.map(([, j]) => ({ x: ref.x[j], y: ref.y[j] })), m.map(([i]) => ({ x: live.x[i], y: live.y[i] }))];

/** For each reference feature, best live feature near its predicted position (spatially constrained). */
export function guidedMatches(live, ref, H, { radius = 8, maxDistance = 60 } = {}) {
  const cell = Math.max(4, radius), cols = Math.ceil(live.w / cell) + 1, grid = new Map();
  for (let i = 0; i < live.n; i++) { const k = Math.floor(live.y[i] / cell) * cols + Math.floor(live.x[i] / cell); const b = grid.get(k); if (b) b.push(i); else grid.set(k, [i]); }
  const used = new Map(), out = [];
  for (let j = 0; j < ref.n; j++) {
    const p = project(H, { x: ref.x[j], y: ref.y[j] }); if (!p || p.x < -radius || p.y < -radius || p.x > live.w + radius || p.y > live.h + radius) continue;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell); let best = maxDistance + 1, bi = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const b = grid.get((cy + dy) * cols + cx + dx); if (!b) continue;
      for (const i of b) { if ((live.x[i] - p.x) ** 2 + (live.y[i] - p.y) ** 2 > radius * radius) continue; const d = hamming(live.desc, i * 8, ref.desc, j * 8); if (d < best) { best = d; bi = i; } }
    }
    if (bi >= 0) { const prev = used.get(bi); if (prev === undefined || out[prev][2] > best) { if (prev !== undefined) out[prev] = null; used.set(bi, out.length); out.push([bi, j, best]); } }
  }
  return out.filter(Boolean);
}

export const REF_FEATURE_OPTS = { levels: 4, scaleStep: 1.45, maxFeatures: 900, threshold: 14 };
export const LIVE_FEATURE_OPTS = { levels: 4, scaleStep: 1.45, maxFeatures: 800, threshold: 12 };

/**
 * Hough consistency (Lowe-style): each match predicts where the reference page centre lands in the
 * live frame, given its rotation (angle difference) and scale (pyramid level difference). True
 * correspondences agree; keep the matches of the dominant bin and its neighbours.
 */
export function consistentMatches(m, live, ref, { angleBins = 12, cell = 64, step = 1.45 } = {}) {
  if (m.length < 8) return m;
  const cx = ref.w / 2, cy = ref.h / 2, keys = new Int32Array(m.length * 4), hist = new Map();
  const pack = (a, l, x, y) => (((a * 32 + (l + 16)) * 512 + (x + 256)) * 512 + (y + 256));
  m.forEach(([i, j], n) => {
    let da = live.angle[i] - ref.angle[j]; da = ((da % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const dl = live.level[i] - ref.level[j], sc = Math.pow(step, dl), c = Math.cos(da), s = Math.sin(da);
    const dx = cx - ref.x[j], dy = cy - ref.y[j], ox = live.x[i] + sc * (c * dx - s * dy), oy = live.y[i] + sc * (s * dx + c * dy);
    const a = Math.floor((da / (2 * Math.PI)) * angleBins) % angleBins, x = Math.max(-255, Math.min(255, Math.floor(ox / cell))), y = Math.max(-255, Math.min(255, Math.floor(oy / cell)));
    keys.set([a, dl, x, y], n * 4); const k = pack(a, dl, x, y); hist.set(k, (hist.get(k) || 0) + 1);
  });
  let best = null, bc = -1;
  for (const k of hist.keys()) { // neighbourhood sum only around occupied bins
    const y = (k % 512) - 256, x = (Math.floor(k / 512) % 512) - 256, l = (Math.floor(k / 262144) % 32) - 16, a = Math.floor(k / 8388608);
    let c = 0;
    for (const da of [-1, 0, 1]) for (const dl of [-1, 0, 1]) for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) c += hist.get(pack((a + da + angleBins) % angleBins, l + dl, x + dx, y + dy)) || 0;
    if (c > bc) { bc = c; best = [a, l, x, y]; }
  }
  const [ba, bl, bx, by] = best;
  return m.filter((_, n) => { const a = keys[n * 4], d = Math.min((a - ba + angleBins) % angleBins, (ba - a + angleBins) % angleBins); return d <= 1 && Math.abs(keys[n * 4 + 1] - bl) <= 1 && Math.abs(keys[n * 4 + 2] - bx) <= 1 && Math.abs(keys[n * 4 + 3] - by) <= 1; });
}

export class PageIndex {
  constructor() { this.pages = new Map(); this.lsh = new HammingLSH(); }
  /** gray: reference page image (at reference resolution) or null when only cached features are kept
   *  in memory (then pass `size` = {w,h}; pixels are loaded lazily by the engine). */
  addPage(pageId, gray, features = computeFeatures(gray, REF_FEATURE_OPTS), size = gray, thumb = null) {
    thumb ??= makeThumb(gray);
    this.pages.set(pageId, { pageId, w: size.w, h: size.h, gray, features, thumb });
    this.siblingCache = null;
    this.lsh.add(pageId, features);
    return features.n;
  }
  get size() { return this.pages.size; }

  /** Geometric verification of one page against live features. Registration maps reference -> live.
   *  With `priorH` (tracking), matching is guided by the previous registration (fast, no ratio test). */
  verify(live, pageId, { ransacThreshold = 5, priorH = null } = {}) {
    const ref = this.pages.get(pageId); if (!ref || live.n < 8) return null;
    const fail = (inl, m) => ({ page: pageId, inliers: inl, matches: m, score: 0, registration: null });
    let H = null, m = null;
    if (priorH) {
      m = guidedMatches(live, ref.features, priorH, { radius: 28 });
      const r = m.length >= 8 ? ransacHomography(...pairs(m, live, ref.features), { threshold: ransacThreshold, iterations: 300 }) : null;
      if (r && plausibleHomography(r.H, ref.w, ref.h)) H = r.H;
    }
    if (!H) {
      m = consistentMatches(matchFeatures(live, ref.features, { ratio: 0.85 }), live, ref.features);
      if (m.length < 8) return fail(0, m.length);
      const r = ransacHomography(...pairs(m, live, ref.features), { threshold: ransacThreshold, minInliers: 10 });
      if (!r || !plausibleHomography(r.H, ref.w, ref.h)) return fail(r?.inliers ?? 0, m.length);
      H = r.H;
    }
    // refine: guided re-matching around the current registration, then a final robust fit
    m = guidedMatches(live, ref.features, H, { radius: 7 });
    if (m.length < 8) return fail(0, m.length);
    const [src, dst] = pairs(m, live, ref.features);
    const r = ransacHomography(src, dst, { threshold: ransacThreshold - 1, iterations: 200 });
    if (!r || !plausibleHomography(r.H, ref.w, ref.h)) return fail(r?.inliers ?? 0, m.length);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    src.forEach((p, k) => { if (r.mask[k]) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } });
    const spread = Math.min(1, ((x1 - x0) * (y1 - y0)) / (ref.w * ref.h * 0.04));
    const ratio = r.inliers / m.length;
    const score = Math.min(0.99, ratio * (0.6 + 0.4 * Math.min(r.inliers, 40) / 40) * (0.7 + 0.3 * spread) + 0.25 * Math.min(1, r.inliers / 60));
    return { page: pageId, inliers: r.inliers, matches: m.length, score, spread, registration: r.H };
  }

  /** Pages whose low-resolution appearance is close to `pageId` (same lesson layout, same glyphs). */
  siblings(pageId, k = 4) {
    if (!this.siblingCache) {
      const ids = [...this.pages.keys()], small = new Map(ids.map(id => [id, highpass(resize(toImg(this.pages.get(id).thumb), 48, 68))]));
      this.siblingCache = new Map(ids.map(a => [a, ids.filter(b => b !== a).map(b => ({ b, s: ncc(small.get(a), small.get(b)) })).filter(x => x.s > 0.35).sort((x, y) => y.s - x.s).map(x => x.b)]));
    }
    return (this.siblingCache.get(pageId) || []).slice(0, k);
  }

  /** Content check: lighting-normalised correlation between the live frame and the registered reference. */
  dense(liveGray, pageId, H) {
    const ref = this.pages.get(pageId), t = ref?.thumb; if (!t || !H) return { dense: null, coverage: 0 };
    const s = ref.w / t.w, scale = Math.sqrt(Math.abs(H[0] * H[4] - H[1] * H[3])) * s;
    const live = scale > 1.6 ? boxBlur(liveGray, Math.round(scale / 2 - 0.3)) : liveGray, lv = new Float32Array(t.w * t.h).fill(NaN);
    let inside = 0;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const p = project(H, { x: (x + 0.5) * s - 0.5, y: (y + 0.5) * s - 0.5 }); if (!p) continue; const v = sample(live, p.x, p.y); if (!Number.isNaN(v)) { lv[y * t.w + x] = v; inside++; } }
    const coverage = inside / (t.w * t.h); if (coverage < 0.04) return { dense: null, coverage };
    const A = highpass(toImg(t), lv), B = highpass({ w: t.w, h: t.h, d: lv });
    return { dense: ncc(A, B), coverage };
  }

  /**
   * Identify the visible page. `prior` pages are verified first (tracking cache). Geometry proposes
   * candidates; page-specific CONTENT decides between near-identical layouts (e.g. the same letter grid
   * with fatha vs kasra), so a page is only accepted when its dense score clearly beats every sibling.
   */
  identify(live, { prior = [], candidates = 3, gray = null, minDense = 0.3, denseMargin = 0.04, quickIterations = 250 } = {}) {
    const tried = new Map(), add = (id, priorH = null) => { if (!tried.has(id) && this.pages.has(id)) { const v = this.verify(live, id, { priorH }); if (v) tried.set(id, v); } };
    for (const id of prior) add(id);
    // 1) one LSH pass gives candidate correspondences for all pages; 2) quick per-page geometry;
    // 3) rank by inliers on page-DISTINCTIVE features (common decoration/grid features excluded)
    const ranking = [];
    for (const [pageId, m] of this.lsh.matchAll(live)) {
      if (m.length < 10 || tried.has(pageId)) continue;
      const ref = this.pages.get(pageId).features, cm = consistentMatches(m, live, ref);
      if (cm.length < 10) continue;
      const r = ransacHomography(...pairs(cm, live, ref), { threshold: 5, iterations: quickIterations, minInliers: 10 });
      if (!r) continue;
      let distinct = 0; cm.forEach((x, k) => { if (r.mask[k] && x[3] <= 1) distinct++; });
      ranking.push({ pageId, inliers: r.inliers, distinct, H: r.H });
    }
    ranking.sort((a, b) => b.distinct - a.distinct || b.inliers - a.inliers);
    for (const c of ranking.slice(0, candidates)) add(c.pageId, c.H);
    const geo = () => [...tried.values()].filter(v => v.registration && choosePage([v]).page !== null);
    for (const g of geo()) for (const sib of this.siblings(g.page, 3)) add(sib, g.registration); // same layout -> guided, cheap
    const valid = geo(), shortlist = ranking.slice(0, 5).map(c => ({ owner: c.pageId, distinct: c.distinct, inliers: c.inliers }));
    if (!valid.length) return { page: null, reason: choosePage([...tried.values()]).reason, evaluated: [...tried.values()], votes: shortlist, method: 'identified' };
    if (!gray) { const c = choosePage(valid); return { ...c, registration: c.page !== null ? tried.get(c.page).registration : null, evaluated: [...tried.values()], votes: shortlist, method: 'identified-geometry-only' }; }
    for (const v of valid) Object.assign(v, this.dense(gray, v.page, v.registration));
    valid.sort((a, b) => (b.dense ?? -1) - (a.dense ?? -1));
    const [best, second] = valid, evaluated = [...tried.values()];
    const method = prior.length && best.page === prior[0] ? 'tracked' : 'identified';
    if (!(best.dense >= minDense)) return { page: null, reason: 'insufficient-page-evidence', evaluated, votes: shortlist, method };
    if (second && best.dense - (second.dense ?? -1) < denseMargin) return { page: null, reason: 'ambiguous-page', evaluated, votes: shortlist, method };
    return { page: best.page, confidence: Math.min(best.score, 0.5 + best.dense), registration: best.registration, reason: null, evaluated, votes: shortlist, method };
  }
}

const toImg = t => ({ w: t.w, h: t.h, d: t.d });
export function makeThumb(gray, width = 200) { if (!gray) return null; const r = resize(gray, width, (gray.h * width) / gray.w); return { w: r.w, h: r.h, d: Uint8ClampedArray.from(r.d) }; }
/** Subtract a local mean (removes illumination); NaN-aware when a validity source is given. */
function highpass(img, validFrom = img.d) {
  const { w, h } = img, v = new Float32Array(w * h), m = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) { const ok = !Number.isNaN(validFrom[k]) && !Number.isNaN(img.d[k]); v[k] = ok ? img.d[k] : 0; m[k] = ok ? 1 : 0; }
  const bv = boxBlur({ w, h, d: v }, 4).d, bm = boxBlur({ w, h, d: m }, 4).d, out = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = m[k] && bm[k] > 0.2 ? v[k] - bv[k] / bm[k] : NaN;
  return { w, h, d: out };
}
function ncc(A, B) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let k = 0; k < A.d.length; k++) { const a = A.d[k], b = B.d[k]; if (Number.isNaN(a) || Number.isNaN(b)) continue; n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
  if (n < 50) return -1;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n; return va > 1e-6 && vb > 1e-6 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -1;
}
