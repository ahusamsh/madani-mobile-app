// Vision V3 engine = V2 (unchanged, still the default) + content from the image itself:
//  - targets are snapped to the REAL printed ink of the reference page (ink units: letter body + its harakat),
//    so heuristic zone boxes that are too tall/shifted/overlapping no longer decide the target (p13-w19 class)
//  - ink-aware selection: tolerance from text height, more slack below the glyph (where a tip touches),
//    a tip outside every glyph is accepted only when one glyph is clearly the closest
//  - local verification (NCC) runs on the tight glyph box instead of a loose zone box
import { VisionEngineV2, V2_DEFAULTS } from '../v2/engine-v2.mjs';
import { inkSnappedTokens } from './ink-layout.mjs';
import { selectInkTarget } from './target-v3.mjs';
import { project, invertHomography } from '../recognition-core.mjs';

export const V3_DEFAULTS = { ...V2_DEFAULTS };

export class VisionEngineV3 extends VisionEngineV2 {
  constructor(opts = {}) { super({ ...V3_DEFAULTS, ...opts }); this.version = 'v3'; this.snapped = new Map(); }
  addReferencePage(pageId, ...rest) { this.snapped?.delete(pageId); return super.addReferencePage(pageId, ...rest); }
  tokensFor(pageId) {
    if (this.snapped.has(pageId)) return this.snapped.get(pageId);
    const base = super.tokensFor(pageId), gray = this.index.pages.get(pageId)?.gray;
    if (!gray || !base.length) return base;              // pixels not loaded yet: fall back to zone boxes this frame
    const { tokens } = inkSnappedTokens(gray, base);
    this.snapped.set(pageId, tokens);
    return tokens;
  }
  locatePage(...a) { const r = super.locatePage(...a); this._H = r?.H ?? null; return r; }
  smoothTip(tip, at, ptr) {
    this._axis = null; // pointer direction in PAGE coordinates (from the detector's PCA axis in the frame)
    if (ptr?.axis && ptr?.tip && this._H) { const Hi = invertHomography(this._H), a = project(Hi, ptr.tip), b = project(Hi, { x: ptr.tip.x - ptr.axis.x * 10, y: ptr.tip.y - ptr.axis.y * 10 }); if (a && b) { const dx = a.x - b.x, dy = a.y - b.y, l = Math.hypot(dx, dy) || 1; this._axis = { x: dx / l, y: dy / l }; } }
    return super.smoothTip(tip, at, ptr);
  }
  selectTarget(tip, tokens, page) { const axis = this._axis; return this.lock.select(tip, tokens, page, (t, toks) => selectInkTarget(t, toks, { axis })); }
}
