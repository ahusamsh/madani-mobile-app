// V3 target selection on ink-tight boxes. Tolerance follows text HEIGHT (not the box's smaller side, which collapses
// for thin letters such as ا) and is anisotropic: a finger/pen tip usually touches just BELOW the glyph, so more
// slack below than beside or above. A tip outside every box is accepted only when one glyph is clearly the closest.
import { distanceToBox } from '../recognition-core.mjs';

export function selectInkTarget(tip, tokens, { axis = null, minTextConfidence = 0.63, side = 0.25, below = 0.45, above = 0.35, maxSide = 7, maxBelow = 12, outsideRatio = 2.5 } = {}) {
  if (!tip || !Number.isFinite(tip.x) || !Number.isFinite(tip.y) || !Array.isArray(tokens)) return { target: null, reason: 'no-pointer' };
  const inside = [], near = [];
  for (const t of tokens) {
    const b = t?.box, conf = Number(t?.confidence ?? 0); if (!b || !String(t.text ?? '').trim() || conf < minTextConfidence) continue;
    const dx = Math.max(b.x - tip.x, 0, tip.x - b.x - b.width), up = Math.max(b.y - tip.y, 0), down = Math.max(tip.y - b.y - b.height, 0);
    if (!dx && !up && !down) { inside.push(t); continue; }
    const h = b.height, ok = dx <= Math.min(maxSide, side * h) && up <= Math.min(maxSide, above * h) && down <= Math.min(maxBelow, below * h);
    // pointer axis (page coords, pointing from the hand towards the tip): a glyph BEHIND the tip lies under the
    // finger/pen body itself, so it can neither be the target nor make the target ambiguous
    if (axis) { const vx = Math.min(Math.max(tip.x, b.x), b.x + b.width) - tip.x, vy = Math.min(Math.max(tip.y, b.y), b.y + b.height) - tip.y, vl = Math.hypot(vx, vy) || 1; if ((vx * axis.x + vy * axis.y) / vl < -0.5) continue; } // nearest point of the box
    near.push({ t, d: distanceToBox(tip, b), ok });
  }
  if (inside.length > 1) { // overlapping boxes: smallest box that contains the tip, if clearly smaller
    inside.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
    const [a, b] = inside; if (a.box.width * a.box.height > 0.6 * b.box.width * b.box.height) return { target: null, reason: 'ambiguous-neighbours' };
    return { target: a, confidence: 0.85, reason: null, via: 'inside-smallest' };
  }
  if (inside.length === 1) return { target: inside[0], confidence: 1, reason: null, via: 'inside' };
  near.sort((a, b) => a.d - b.d);
  const [n1, n2] = near; if (!n1?.ok) return { target: null, reason: 'no-text-at-tip' };
  if (n2 && n2.d < outsideRatio * n1.d + 4) return { target: null, reason: 'ambiguous-neighbours' };
  return { target: n1.t, confidence: Math.max(0.6, 1 - n1.d / 20), reason: null, via: 'near' };
}
