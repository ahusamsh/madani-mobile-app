// Madani camera pointer engine: frame -> page -> pointer tip -> word/letter -> existing audio clip.
// Pure JS, local, deterministic. Every frame returns an explainable decision:
// { accepted, play, pageId, targetText, targetId, kind, tip, pointerType, confidence,
//   sourceEvidence, rejectionReason, audio, timings, debug }
import { fromRGBA, frameQuality, boxBlur } from './image.mjs';
import { computeFeatures } from './features.mjs';
import { PageIndex, LIVE_FEATURE_OPTS } from './page-matcher.mjs';
import { detectPointer, localScale } from './pointer.mjs';
import { zoneTokens, verifyLocal, resolveAudio } from './target.mjs';
import { project, invertHomography, chooseTarget, choosePage, PointingGate } from '../recognition-core.mjs';

export const ENGINE_DEFAULTS = {
  identifyIntervalMs: 600,   // full-book identification is throttled; tracking runs every frame
  siblingCheckMs: 1200,      // content re-check against same-layout pages while tracking
  confirmHits: 2,            // a newly identified page must be seen twice before use
  trackMisses: 2,            // tracking failures before falling back to identification
  minLocalNcc: 0.45,         // zone pixels must still look like the reference zone
  minVisible: 0.3,           // at least this share of the zone must be unoccluded
  pointer: {},
  gate: {},
};

export class VisionEngine {
  constructor({ library, index = new PageIndex(), ...opts } = {}) {
    this.library = library; this.index = index; this.opt = { ...ENGINE_DEFAULTS, ...opts };
    this.gate = new PointingGate(this.opt.gate);
    this.tokens = new Map(); this.smooth = new Map();
    this.reset();
  }
  reset() { this.track = null; this.pending = null; this.lastIdentifyAt = -Infinity; this.gate.reset(); }

  /** Register a reference page image (gray {w,h,d}) under its canonical pdf page id. */
  addReferencePage(pageId, gray, features, size, thumb) { this.tokens.delete(pageId); this.smooth.delete(pageId); return this.index.addPage(pageId, gray, features ?? undefined, size ?? gray, thumb); }

  /** Reference pixels for a page; with opts.loadGray (async) pages are fetched on demand and kept in a small LRU. */
  refGray(pageId) {
    const ref = this.index.pages.get(pageId); if (!ref) return null;
    if (ref.gray) { this.lru = [pageId, ...(this.lru || []).filter(p => p !== pageId)]; return ref.gray; }
    if (!this.opt.loadGray || this.loading?.has(pageId)) return null;
    (this.loading ??= new Set()).add(pageId);
    Promise.resolve(this.opt.loadGray(pageId)).then(g => {
      if (!g) return; ref.gray = g; this.lru = [pageId, ...(this.lru || []).filter(p => p !== pageId)];
      for (const old of this.lru.splice(this.opt.keepPages ?? 4)) { const r = this.index.pages.get(old); if (r) r.gray = null; for (const k of this.smooth.keys()) if (k.startsWith(old + ':')) this.smooth.delete(k); }
    }).catch(() => {}).finally(() => this.loading.delete(pageId));
    return null;
  }

  tokensFor(pageId) {
    if (!this.tokens.has(pageId)) { const ref = this.index.pages.get(pageId); this.tokens.set(pageId, zoneTokens(this.library, pageId, ref.w, ref.h)); }
    return this.tokens.get(pageId);
  }
  smoothFor(pageId, radius) {
    const key = `${pageId}:${radius}`;
    if (!this.smooth.has(key)) this.smooth.set(key, boxBlur(this.refGray(pageId), radius));
    return this.smooth.get(key);
  }

  locatePage(F, at, gray) {
    const t = this.track;
    if (t) {
      const v = this.index.verify(F, t.page, { priorH: t.H }), ok = v && choosePage([v]).page === t.page;
      if (ok) {
        t.H = v.registration; t.confidence = choosePage([v]).confidence; t.misses = 0; t.evidence = v;
        // near-identical sibling pages (same layout) are re-checked by content periodically while tracking
        if (at - (t.checkedAt ?? -Infinity) >= this.opt.siblingCheckMs) {
          t.checkedAt = at;
          const r = this.index.identify(F, { prior: [t.page], candidates: 0, budgetPages: 0, gray });
          if (r.page === null) { t.ambiguous = r.reason; } else { t.ambiguous = null; if (r.page !== t.page) { this.track = null; this.pending = null; this.lastIdentifyAt = -Infinity; return { page: null, reason: 'page-changed' }; } }
        }
        if (t.ambiguous) return { page: null, reason: t.ambiguous };
        return { page: t.page, H: t.H, confidence: t.confidence, method: 'tracked', evidence: v };
      }
      t.misses++;
      if (t.misses < this.opt.trackMisses && t.H) return null; // brief dropout: no output this frame, keep the track
    }
    if (at - this.lastIdentifyAt < this.opt.identifyIntervalMs) return null;
    this.lastIdentifyAt = at;
    const prior = t ? [t.page, t.page + 1, t.page - 1] : [];
    const r = this.index.identify(F, { prior, gray });
    if (r.page === null) { if (!t || t.misses >= this.opt.trackMisses * 4) this.track = null; return { page: null, reason: r.reason, evaluated: r.evaluated }; }
    const seen = this.pending?.page === r.page ? this.pending.hits + 1 : 1;
    this.pending = { page: r.page, hits: seen };
    if (seen < this.opt.confirmHits && r.page !== t?.page) { this.lastIdentifyAt = -Infinity; return { page: null, reason: 'confirming-page', candidate: r.page }; }
    this.track = { page: r.page, H: r.registration, confidence: r.confidence, misses: 0, checkedAt: at };
    const ev = r.evaluated.find(e => e.page === r.page);
    return { page: r.page, H: r.registration, confidence: r.confidence, method: r.method, evidence: ev };
  }

  /** frame: {rgba (Uint8ClampedArray), width, height, at (ms)} at working resolution (~480 px wide). */
  processFrame({ rgba, width, height, at }) {
    const T0 = performance.now(), timings = {};
    const gray = fromRGBA(rgba, width, height), quality = frameQuality(gray);
    const F = computeFeatures(gray, LIVE_FEATURE_OPTS); timings.features = performance.now() - T0;
    const T1 = performance.now(), loc = this.locatePage(F, at, gray); timings.page = performance.now() - T1;
    const base = { accepted: false, play: false, pageId: null, targetText: null, targetId: null, kind: null, tip: null, pointerType: null, confidence: 0, audio: null, quality, timings };
    const finish = (r) => { timings.total = performance.now() - T0; return r; };
    if (!loc || loc.page === null) {
      this.gate.update({ at });
      const reason = ['confirming-page', 'page-changed', 'ambiguous-page'].includes(loc?.reason) ? loc.reason : quality.weak ?? (loc ? (loc.reason ?? 'page-not-identified') : this.track ? 'page-tracking-dropout' : 'page-not-identified');
      return finish({ ...base, rejectionReason: reason, sourceEvidence: { page: loc ?? null }, debug: { features: F.n } });
    }
    if (quality.weak) { // conservative: a page may still register, but the pixels are not trustworthy enough to speak
      this.gate.update({ at });
      return finish({ ...base, pageId: loc.page, rejectionReason: quality.weak, sourceEvidence: { page: { method: loc.method, score: loc.confidence } }, debug: { features: F.n } });
    }
    const ref = this.index.pages.get(loc.page), H = loc.H, Hinv = invertHomography(H);
    if (!this.refGray(loc.page)) { this.gate.update({ at }); return finish({ ...base, pageId: loc.page, rejectionReason: 'loading-reference-page', debug: { features: F.n } }); }
    const pageInfo = { page: loc.page, confidence: loc.confidence, evidence: `${loc.method}:${loc.evidence?.inliers ?? '?'}inliers` };
    const debug = { H, refSize: [ref.w, ref.h], outline: [[0, 0], [ref.w, 0], [ref.w, ref.h], [0, ref.h]].map(([x, y]) => project(H, { x, y })), features: F.n };
    const T2 = performance.now(), ptr = detectPointer(gray, ref.gray, H, { rgba, ...this.opt.pointer }); timings.pointer = performance.now() - T2;
    debug.pointer = ptr.debug ? { w: ptr.debug.w, h: ptr.debug.h, work: ptr.debug.work, mask: ptr.debug.mask } : null;
    const result = { ...base, pageId: loc.page, pointerType: ptr.type, sourceEvidence: { page: { method: loc.method, inliers: loc.evidence?.inliers, matches: loc.evidence?.matches, score: loc.confidence }, pointer: ptr.evidence ?? null }, debug };
    if (!ptr.tip || !ptr.type) {
      this.gate.update({ at, page: pageInfo });
      return finish({ ...result, rejectionReason: ptr.reason === 'no-pointer-evidence' && quality.weak ? quality.weak : ptr.reason });
    }
    const tipPage = project(Hinv, ptr.tip);
    result.tip = { frame: ptr.tip, page: tipPage };
    if (ptr.type === 'uncertain') { this.gate.update({ at, page: pageInfo, pointer: { type: 'uncertain', confidence: 0, tip: tipPage } }); return finish({ ...result, rejectionReason: ptr.reason }); }
    if (!tipPage || tipPage.x < 0 || tipPage.y < 0 || tipPage.x > ref.w || tipPage.y > ref.h) { this.gate.update({ at, page: pageInfo }); return finish({ ...result, rejectionReason: 'tip-outside-page' }); }
    const T3 = performance.now(), tokens = this.tokensFor(loc.page);
    let selection = tokens.length ? chooseTarget(tipPage, tokens) : { target: null, reason: 'page-has-no-zone-map' };
    debug.candidates = tokens.filter(t => Math.abs(t.box.x + t.box.width / 2 - tipPage.x) < t.box.width * 1.5 + 20 && Math.abs(t.box.y + t.box.height / 2 - tipPage.y) < t.box.height * 1.5 + 20).map(t => ({ id: t.id, text: t.text, corners: [[t.box.x, t.box.y], [t.box.x + t.box.width, t.box.y], [t.box.x + t.box.width, t.box.y + t.box.height], [t.box.x, t.box.y + t.box.height]].map(([x, y]) => project(H, { x, y })) }));
    if (selection.target) {
      const sc = localScale(H, tipPage), radius = Math.max(0, Math.round(0.5 / sc - 0.5));
      const ev = verifyLocal(gray, this.smoothFor(loc.page, radius), H, selection.target.box, ptr.debug ? { ...ptr.debug } : null);
      const local = { ncc: ev.ncc === null ? null : +ev.ncc.toFixed(3), visible: +ev.visible.toFixed(2), inkStd: +ev.inkStd.toFixed(1) };
      if (ev.visible < this.opt.minVisible) selection = { target: null, reason: 'target-occluded', evidence: local };
      else if (ev.inkStd > 12 && (ev.ncc === null || ev.ncc < this.opt.minLocalNcc)) selection = { target: null, reason: 'local-evidence-mismatch', evidence: local };
      else selection = { ...selection, confidence: selection.confidence * (ev.ncc === null ? 0.9 : 0.75 + 0.25 * Math.max(0, ev.ncc)), evidence: local };
      result.sourceEvidence.text = local;
    }
    timings.target = performance.now() - T3;
    const decision = this.gate.update({ at, page: pageInfo, pointer: { type: ptr.type, confidence: ptr.confidence, tip: tipPage }, selection });
    if (!decision.accepted) return finish({ ...result, confidence: selection.target ? +selection.confidence.toFixed(3) : 0, rejectionReason: decision.rejectionReason, candidateId: selection.target?.id ?? null });
    const token = tokens.find(t => t.id === decision.targetId), audio = resolveAudio(this.library, loc.page, token.zone);
    debug.accepted = token && { id: token.id, corners: [[token.box.x, token.box.y], [token.box.x + token.box.width, token.box.y], [token.box.x + token.box.width, token.box.y + token.box.height], [token.box.x, token.box.y + token.box.height]].map(([x, y]) => project(H, { x, y })) };
    return finish({
      ...result, accepted: true, play: !!audio, targetText: decision.targetText, targetId: decision.targetId, kind: decision.kind, spokenText: token.spokenText,
      confidence: +decision.confidence.toFixed(3), audio, rejectionReason: audio ? null : 'no-audio-mapping',
      sourceEvidence: { ...result.sourceEvidence, text: { source: token.source, ...(result.sourceEvidence.text || {}) }, audio: audio ? audio.via : 'not-available' },
    });
  }
}
