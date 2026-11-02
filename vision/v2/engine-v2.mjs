// Offline Vision V2 engine. Built ON the baseline VisionEngine (vision/engine/engine.mjs), which stays
// unchanged and selectable. V2 only overrides the baseline's extension hooks and options:
//  - tip tracking in page coordinates (median smoothing, single-frame outlier rejection, instant reset on a clear move)
//  - target lock (hysteresis): small jitter keeps the current word, entering another word switches immediately
//  - faster page confirmation when the content evidence is unambiguous (dense score + margin)
//  - cheaper per-frame work: lighter tracking features, cached warped reference, sibling re-check without a full-book search
//  - hysteresis pointer segmentation (weak evidence only when connected to strong evidence) for light pens / low contrast
import { VisionEngine, ENGINE_DEFAULTS } from '../engine/engine.mjs';
import { LIVE_FEATURE_OPTS } from '../engine/page-matcher.mjs';
import { chooseTarget, distanceToBox } from '../recognition-core.mjs';

export const TRACKING_FEATURE_OPTS = { levels: 3, scaleStep: 1.45, maxFeatures: 550, threshold: 12 };
/** Before a page is locked: a lower corner threshold keeps enough features on partial / off-centre views. */
export const SEARCH_FEATURE_OPTS = { ...LIVE_FEATURE_OPTS, threshold: 10 };

export const V2_DEFAULTS = {
  ...ENGINE_DEFAULTS,
  identifyIntervalMs: 350,
  identify: { quickMinInliers: 8 },
  siblingCheckMs: 2000,
  siblingSearchAll: false,
  fastConfirm: { minDense: 0.6, minMargin: 0.15 },
  gate: { frames: 3, holdMs: 140 },
  pointer: { weakDarkRatio: 0.8, weakChroma: 8 },
  tip: { window: 3, jumpPx: 12, bigJumpPx: 26 },  // reference px (640 px wide page; ~3.8 px per mm)
  lock: { keepPx: 5, keepFrac: 0.18 },
};

/** Median-smoothed tip with outlier rejection. Small jitter is absorbed, a clear move resets instantly. */
export class TipTracker {
  constructor({ window = 3, jumpPx = 12, bigJumpPx = 26 } = {}) { Object.assign(this, { window, jumpPx, bigJumpPx }); this.reset(); }
  reset() { this.hist = []; this.pending = null; this.smoothed = null; }
  update(p) {
    if (!p) return null;
    if (this.smoothed) {
      const d = Math.hypot(p.x - this.smoothed.x, p.y - this.smoothed.y);
      if (d > this.bigJumpPx) { this.hist = []; this.pending = null; }                 // deliberate move: follow at once
      else if (d > this.jumpPx) {                                                       // moderate jump: need 2 frames
        if (this.pending && Math.hypot(p.x - this.pending.x, p.y - this.pending.y) < this.jumpPx) { this.hist = [this.pending]; this.pending = null; }
        else { this.pending = p; return this.smoothed; }                                 // single-frame outlier ignored
      } else this.pending = null;
    }
    this.hist.push(p); if (this.hist.length > this.window) this.hist.shift();
    const med = k => { const v = this.hist.map(q => q[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    this.smoothed = { x: med('x'), y: med('y') };
    return this.smoothed;
  }
}

/** Keeps the current target under small jitter; switches as soon as the tip is inside another target. */
export class TargetLock {
  constructor({ keepPx = 5, keepFrac = 0.18 } = {}) { Object.assign(this, { keepPx, keepFrac }); this.reset(); }
  reset() { this.page = null; this.id = null; }
  select(tip, tokens, page, choose = chooseTarget) {
    const raw = choose(tip, tokens);
    if (this.id !== null && this.page === page) {
      const locked = tokens.find(t => t.id === this.id);
      if (locked) {
        const keep = Math.min(this.keepPx, this.keepFrac * Math.min(locked.box.width, locked.box.height));
        const insideOther = raw.target && raw.target.id !== locked.id && distanceToBox(tip, raw.target.box) === 0;
        if (!insideOther && distanceToBox(tip, locked.box) <= keep)
          return { target: locked, confidence: Math.max(raw.target?.id === locked.id ? raw.confidence : 0, 0.75), reason: null, locked: true };
      }
    }
    if (raw.target) { this.page = page; this.id = raw.target.id; } else this.reset();
    return raw;
  }
}

export class VisionEngineV2 extends VisionEngine {
  constructor({ library, index, ...opts } = {}) {
    const o = { ...V2_DEFAULTS, ...opts, gate: { ...V2_DEFAULTS.gate, ...(opts.gate || {}) }, pointer: { ...V2_DEFAULTS.pointer, ...(opts.pointer || {}) } };
    super({ library, ...(index ? { index } : {}), ...o });
    this.version = 'v2';
    this.tipTracker = new TipTracker(o.tip); this.lock = new TargetLock(o.lock);
    this.opt.pointer = { ...this.opt.pointer, refCache: {} };
  }
  reset() { super.reset(); this.tipTracker?.reset(); this.lock?.reset(); if (this.opt?.pointer?.refCache) this.opt.pointer.refCache = {}; }
  liveFeatureOpts() { return this.track && !this.track.misses ? TRACKING_FEATURE_OPTS : this.track ? LIVE_FEATURE_OPTS : SEARCH_FEATURE_OPTS; }
  fastConfirm(r) { const f = this.opt.fastConfirm; return !!f && r.dense >= f.minDense && r.denseMargin >= f.minMargin; }
  smoothTip(tip) { return this.tipTracker.update(tip); }
  pointerLost() { this.tipTracker.reset(); this.lock.reset(); }
  selectTarget(tip, tokens, page) { return this.lock.select(tip, tokens, page); }
}
