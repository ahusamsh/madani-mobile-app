// V3: decide between near-identical pages (same lesson grid, different harakat/titles) at full resolution.
// Under ONE geometry at a time (each candidate's registration in turn) all candidate references are sampled with the
// SAME homography, so "pixels where the references differ" are true content differences (fatha above vs kasra below,
// a different title), not registration edges. The live frame is compared with each reference only on those pixels.
// A winner is returned only if every geometry agrees and the error ratio is decisive.
import { sample, boxBlur } from '../engine/image.mjs';
import { invertHomography } from '../recognition-core.mjs';

function sampleWith(ref, M, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const z = M[6] * x + M[7] * y + M[8]; out[y * w + x] = sample(ref, (M[0] * x + M[1] * y + M[2]) / z, (M[3] * x + M[4] * y + M[5]) / z); }
  return out;
}

/** live: gray frame; cands: [{page, H (ref->frame), gray (reference)}]. */
export function discriminatePages(live, cands, { minDiff = 45, minPixels = 40, minRatio = 1.25, maxShift = 2 } = {}) {
  const { w, h } = live, n = cands.length, N = w * h;
  const refs = cands.map(c => { const sc = Math.sqrt(Math.abs(c.H[0] * c.H[4] - c.H[1] * c.H[3])); return boxBlur(c.gray, Math.max(0, Math.round(0.5 / sc - 0.5))); });
  const perGeometry = [];
  for (const g of cands) {
    const M = invertHomography(g.H); if (!M) return { winner: null, reason: 'no-registration' };
    const V = refs.map(r => sampleWith(r, M, w, h));
    // small residual alignment of the live frame, estimated on ink shared by all references (neutral)
    const shared = []; for (let k = 0; k < N; k += 2) { let lo = 255, hi = 0, ok = true; for (const v of V) { const x = v[k]; if (Number.isNaN(x)) { ok = false; break; } lo = Math.min(lo, x); hi = Math.max(hi, x); } if (ok && hi < 150 && hi - lo < 25) shared.push(k); }
    let sh = [0, 0], be = Infinity;
    for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) { let e = 0, m = 0; for (const k of shared) { const x = (k % w) + dx, y = ((k / w) | 0) + dy; if (x < 0 || y < 0 || x >= w || y >= h) continue; e += Math.abs(live.d[y * w + x] - V[0][k]); m++; } if (m && e / m < be) { be = e / m; sh = [dx, dy]; } }
    const L = [], R = V.map(() => []);
    for (let k = 0; k < N; k++) {
      let lo = 255, hi = 0, ok = true; for (const v of V) { const x = v[k]; if (Number.isNaN(x)) { ok = false; break; } lo = Math.min(lo, x); hi = Math.max(hi, x); }
      if (!ok || hi - lo < minDiff) continue;
      const x = (k % w) + sh[0], y = ((k / w) | 0) + sh[1]; if (x < 0 || y < 0 || x >= w || y >= h) continue;
      L.push(live.d[y * w + x]); V.forEach((v, i) => R[i].push(v[k]));
    }
    if (L.length < minPixels) { perGeometry.push({ geometry: g.page, winner: null, pixels: L.length }); continue; }
    const errs = R.map(r => { // photometric fit live ≈ a*ref + b, then mean absolute residual
      const m = r.length; let sr = 0, sl = 0, srr = 0, srl = 0; for (let k = 0; k < m; k++) { sr += r[k]; sl += L[k]; srr += r[k] * r[k]; srl += r[k] * L[k]; }
      const vr = srr - (sr * sr) / m, a = vr > 1e-6 ? Math.max(0.2, Math.min(3, (srl - (sr * sl) / m) / vr)) : 1, b = (sl - a * sr) / m;
      let e = 0; for (let k = 0; k < m; k++) e += Math.abs(L[k] - (a * r[k] + b)); return e / m;
    });
    const order = errs.map((e, i) => [e, i]).sort((p, q) => p[0] - q[0]), decisive = order[1][0] / Math.max(1e-6, order[0][0]) >= minRatio;
    perGeometry.push({ geometry: g.page, winner: decisive ? cands[order[0][1]].page : null, errs: Object.fromEntries(errs.map((e, i) => [cands[i].page, +e.toFixed(2)])), pixels: L.length, shift: sh });
  }
  // a geometry without a decisive result abstains (e.g. a loosely related sibling registers poorly);
  // any two decisive geometries that disagree block the decision
  // the FIRST candidate is the best-registered one (highest content score): its geometry must decide; the others
  // may only confirm or block (a candidate with a poor registration must not make its own reference 'match')
  const lead = perGeometry[0]?.winner ?? null, others = new Set(perGeometry.slice(1).map(p => p.winner).filter(v => v != null));
  const winner = lead !== null && [...others].every(v => v === lead) ? lead : null;
  return { winner, reason: winner ? null : 'siblings-indistinguishable', perGeometry };
}
