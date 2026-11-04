// V3 target selection on ink-tight boxes. Tolerance follows text HEIGHT (not the box's smaller side, which collapses
// for thin letters such as ا) and is anisotropic: a finger/pen tip usually touches just BELOW the glyph, so more
// slack below than beside or above. A tip outside every box is accepted only when one glyph is clearly the closest.
import { distanceToBox } from '../recognition-core.mjs';

function selectRaw(tip, tokens, { axis = null, aheadPx = 11, minTextConfidence = 0.63, side = 0.25, below = 0.45, above = 0.35, maxSide = 7, maxBelow = 12, outsideRatio = 2.5 } = {}) {
  if (!tip || !Number.isFinite(tip.x) || !Number.isFinite(tip.y) || !Array.isArray(tokens)) return { target: null, reason: 'no-pointer' };
  const inside = [], near = [];
  for (const t of tokens) {
    const conf = Number(t?.confidence ?? 0); if (!t?.box || !String(t.text ?? '').trim() || conf < minTextConfidence) continue;
    let best = null; // nearest ink part of this token (or its single box)
    for (const b of t.parts?.length ? t.parts : [t.box]) {
      const dx = Math.max(b.x - tip.x, 0, tip.x - b.x - b.width), up = Math.max(b.y - tip.y, 0), down = Math.max(tip.y - b.y - b.height, 0), d = distanceToBox(tip, b);
      if (!best || d < best.d) best = { b, dx, up, down, d };
    }
    const { b, dx, up, down, d } = best;
    if (!d) { inside.push(t); continue; }
    const hgt = b.height, ok = dx <= Math.min(maxSide, side * hgt) && up <= Math.min(maxSide, above * hgt) && down <= Math.min(maxBelow, below * hgt);
    // pointer axis (page coords, pointing from the hand towards the tip): a glyph BEHIND the tip lies under the
    // finger/pen body itself, so it can neither be the target nor make the target ambiguous
    if (axis) { const vx = Math.min(Math.max(tip.x, b.x), b.x + b.width) - tip.x, vy = Math.min(Math.max(tip.y, b.y), b.y + b.height) - tip.y, vl = Math.hypot(vx, vy) || 1; if ((vx * axis.x + vy * axis.y) / vl < -0.5) continue; } // nearest point of the box
    near.push({ t, d, ok });
  }
  if (inside.length > 1) { // overlapping boxes: smallest box that contains the tip, if clearly smaller
    const ar = t => (t.parts?.length ? t.parts : [t.box]).reduce((s, b) => s + b.width * b.height, 0);
    inside.sort((a, b) => ar(a) - ar(b));
    const [a, b] = inside; if (ar(a) > 0.6 * ar(b)) return { target: null, reason: 'ambiguous-neighbours' };
    return { target: a, confidence: 0.85, reason: null, via: 'inside-smallest' };
  }
  if (inside.length === 1) return { target: inside[0], confidence: 1, reason: null, via: 'inside' };
  near.sort((a, b) => a.d - b.d);
  const [n1, n2] = near; if (!n1?.ok) return { target: null, reason: 'no-text-at-tip' };
  if (n2 && n2.d < outsideRatio * n1.d + 4) return { target: null, reason: 'ambiguous-neighbours' };
  return { target: n1.t, confidence: Math.max(0.6, 1 - n1.d / 20), reason: null, via: 'near' };
}

/**
 * A dark tip over dark print is invisible for its last ~1-3 mm, so the estimated tip falls SHORT of the true tip
 * (towards the hand), never beyond it. If a DIFFERENT glyph lies within that distance ahead along the pointer axis
 * than the one selected at the estimated tip, the real target is uncertain: refuse rather than guess.
 */
export function selectInkTarget(tip, tokens, opts = {}) {
  const r = selectRaw(tip, tokens, opts), { axis = null, aheadPx = 11 } = opts;
  if (!r.target || !axis) return r;
  const at = p => tokens.find(t => (t.parts?.length ? t.parts : [t.box]).some(b => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height));
  for (const f of [0.5, 1]) { const q = at({ x: tip.x + axis.x * aheadPx * f, y: tip.y + axis.y * aheadPx * f }); if (q && q !== r.target) return { target: null, reason: 'tip-uncertain-along-axis' }; }
  return r;
}
