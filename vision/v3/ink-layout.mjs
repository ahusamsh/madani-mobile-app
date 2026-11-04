// V3: real printed content from the reference page image.
// 1) ink units = connected ink components (letters) merged with their harakat/dots (vertically stacked, overlapping in x)
// 2) zone snapping: every ink unit is assigned to at most ONE zone (the zone containing most of it); a zone's
//    box becomes the tight union of its units. This repairs heuristic zone boxes that are too tall / shifted and
//    overlap neighbours (root cause of the documented p13-w19 'uncertain' failure).

/** Ink mask: dark or saturated print, excluding light cell backgrounds and faint grid lines. */
export function inkMask(gray, { thresh = 165, localDelta = 28, r = 7 } = {}) {
  const { w, h, d } = gray, S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += d[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    const mean = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    const v = d[y * w + x]; m[y * w + x] = v < thresh && v < mean - localDelta ? 1 : 0;
  }
  return removeRulings(m, w, h);
}

/** Remove table/grid rulings: long thin horizontal or vertical runs (letters touching the grid would otherwise merge with it). */
export function removeRulings(m, w, h, { minRun = 24, maxThick = 3 } = {}) {
  const kill = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w;) {
    if (!m[y * w + x]) { x++; continue; }
    let e = x; while (e < w && m[y * w + e]) e++;
    if (e - x >= minRun) for (let k = x; k < e; k++) { let t = 1; for (let yy = y - 1; yy >= 0 && m[yy * w + k] && t <= maxThick; yy--) t++; for (let yy = y + 1; yy < h && m[yy * w + k] && t <= maxThick; yy++) t++; if (t <= maxThick) kill[y * w + k] = 1; }
    x = e;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h;) {
    if (!m[y * w + x]) { y++; continue; }
    let e = y; while (e < h && m[e * w + x]) e++;
    if (e - y >= minRun) for (let k = y; k < e; k++) { let t = 1; for (let xx = x - 1; xx >= 0 && m[k * w + xx] && t <= maxThick; xx--) t++; for (let xx = x + 1; xx < w && m[k * w + xx] && t <= maxThick; xx++) t++; if (t <= maxThick) kill[k * w + x] = 1; }
    y = e;
  }
  return m.map((v, k) => (v && !kill[k] ? 1 : 0));
}

/** Connected components (8-neighbour) with bbox + pixel count; drops specks and ruling lines. */
export function components(mask, w, h, { minPx = 4 } = {}) {
  const lab = new Int32Array(w * h).fill(-1), out = [], st = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0; st.push(s); lab[s] = out.length;
    while (st.length) {
      const k = st.pop(), x = k % w, y = (k / w) | 0; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const q = yy * w + xx; if (mask[q] && lab[q] < 0) { lab[q] = out.length; st.push(q); } }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = n / (bw * bh);
    const ruling = (bw > w * 0.15 && bh < 6) || (bh > h * 0.1 && bw < 6) || (bw * bh > w * h * 0.02 && fill < 0.08);
    out.push({ x0, y0, x1, y1, n, keep: n >= minPx && !ruling });
  }
  return out.filter(c => c.keep).map(({ keep, ...c }) => c);
}

/** Merge diacritics/dots with the letter body they belong to (stacked vertically, overlapping horizontally). */
export function inkUnits(comps, { gapFrac = 0.8 } = {}) {
  // one step, no chaining: letter bodies never merge with each other; each small mark (haraka, dot, shadda, tanween)
  // attaches to the single nearest body it overlaps horizontally
  const sizes = comps.map(c => c.n).sort((a, b) => a - b), med = sizes[sizes.length >> 1] || 1;
  const isBody = c => c.n >= med * 0.6 || (c.y1 - c.y0) >= 9;
  const bodies = comps.filter(isBody).map(c => ({ ...c, parts: 1 })), marks = comps.filter(c => !isBody(c)), loose = [];
  for (const m of marks) {
    let best = null, bd = Infinity;
    for (const b of bodies) {
      const ox = Math.min(m.x1, b.x1) - Math.max(m.x0, b.x0) + 1, gap = Math.max(m.y0, b.y0) - Math.min(m.y1, b.y1), bh = b.y1 - b.y0 + 1;
      if (ox < (m.x1 - m.x0 + 1) * 0.5 || gap > bh * gapFrac) continue;
      const dd = Math.max(0, gap) + Math.abs((m.x0 + m.x1) - (b.x0 + b.x1)) / 4; if (dd < bd) { bd = dd; best = b; }
    }
    if (best) Object.assign(best, { x0: Math.min(best.x0, m.x0), y0: Math.min(best.y0, m.y0), x1: Math.max(best.x1, m.x1), y1: Math.max(best.y1, m.y1), n: best.n + m.n, parts: best.parts + 1 });
    else loose.push({ ...m, parts: 1 });
  }
  return [...bodies, ...loose];
}

const area = b => Math.max(0, b.x1 - b.x0 + 1) * Math.max(0, b.y1 - b.y0 + 1);
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/**
 * Snap zone boxes (tokens in reference px, {box:{x,y,width,height}}) to ink units. Returns new tokens with
 * `box` = tight ink box, `zoneBox` = original, `snap` = 'ink' | 'zone-only'. A unit goes to the zone that covers the
 * largest share of it (≥ minShare); zones never share a unit, so snapped boxes do not overlap.
 */
export function snapTokens(tokens, units, { minShare = 0.45, pad = 2 } = {}) {
  const zb = tokens.map(t => ({ x0: t.box.x, y0: t.box.y, x1: t.box.x + t.box.width, y1: t.box.y + t.box.height }));
  const owned = tokens.map(() => []);
  for (const u of units) {
    let best = -1, bs = 0, second = 0;
    zb.forEach((z, i) => { const s = inter(u, z) / area(u); if (s > bs) { second = bs; bs = s; best = i; } else if (s > second) second = s; });
    if (best >= 0 && bs >= minShare && bs - second > 0.1) owned[best].push(u);
  }
  return tokens.map((t, i) => {
    const us = owned[i];
    if (!us.length) return { ...t, zoneBox: t.box, snap: 'zone-only' };
    const x0 = Math.min(...us.map(u => u.x0)) - pad, y0 = Math.min(...us.map(u => u.y0)) - pad, x1 = Math.max(...us.map(u => u.x1)) + pad, y1 = Math.max(...us.map(u => u.y1)) + pad;
    return { ...t, zoneBox: t.box, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, snap: 'ink', units: us.length };
  });
}

/** Convenience: ink-snapped tokens for one reference page. */
export function inkSnappedTokens(gray, tokens, opts = {}) {
  const units = inkUnits(components(inkMask(gray, opts), gray.w, gray.h));
  return { tokens: snapTokens(tokens, units, opts), units };
}
