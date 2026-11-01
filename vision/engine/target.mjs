// Content targets (words / isolated letters) and their audio, from the existing audio library.
import { sample } from './image.mjs';
import { project } from '../recognition-core.mjs';

const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ\s]/gu; // harakat, Quranic marks, tatweel

/** 'letter' when the zone is a single base letter (with or without tatweel / harakat), else 'word'. */
export function kindOf(zone) {
  if (zone?.kind === 'letter' || zone?.kind === 'word') return zone.kind;
  return [...String(zone?.text ?? '').replace(MARKS, '')].length === 1 ? 'letter' : 'word';
}

/** Same rule as app.js safeClip(): relative, inside the app, no traversal. */
export function safeClip(path) {
  if (typeof path !== 'string') return null;
  const clean = path.replace(/^\.\//, '');
  if (!clean || clean.includes('..') || /^(https?:|\/|[a-z]+:)/i.test(clean) || !/\.(mp3|m4a|ogg|wav)$/i.test(clean)) return null;
  return './' + clean;
}

/**
 * Resolve the PRE-EXISTING audio for a zone. Order: the zone's own segment (segments[zone.id]);
 * otherwise its parent box clip ONLY when that box contains exactly this one zone (a multi-word box
 * clip would speak neighbours). Nothing else; absent mapping => null (stay silent).
 */
export function resolveAudio(library, pageId, zone) {
  const seg = library?.segments?.[zone?.id];
  const clip = safeClip(seg?.clip);
  if (seg && clip && (seg.page === undefined || Number(seg.page) === Number(pageId)))
    return { clip, segmentId: zone.id, start: seg.start ?? null, end: seg.end ?? null, reviewed: !!seg.reviewed, status: seg.status ?? null, via: 'segment' };
  const page = library?.pages?.[String(pageId)], box = page?.boxes?.find(b => b.id === zone?.parentBoxId);
  const boxClip = safeClip(box?.clip);
  if (box && boxClip && Array.isArray(box.wordIds) && box.wordIds.length === 1 && box.wordIds[0] === zone.id)
    return { clip: boxClip, segmentId: box.id, start: box.start ?? null, end: box.end ?? null, reviewed: !!box.reviewed, status: 'box-clip', via: 'single-zone-box' };
  return null;
}

/** Tokens for chooseTarget(), in reference-image pixels. */
export function zoneTokens(library, pageId, refW, refH) {
  const page = library?.pages?.[String(pageId)];
  if (!page?.zones?.length) return [];
  const conf = page.zoneStatus === 'pilot-geometry' ? 0.95 : 0.8;
  return page.zones.filter(z => Array.isArray(z.box) && z.box.length === 4 && z.box.every(Number.isFinite)).map(z => ({
    id: z.id, text: z.text, spokenText: z.spokenText ?? null, kind: kindOf(z), confidence: z.geometryReviewed ? Math.max(conf, 0.9) : conf,
    source: 'audio-library-zone', zone: z,
    box: { x: z.box[0] * refW, y: z.box[1] * refH, width: z.box[2] * refW, height: z.box[3] * refH },
  }));
}

/**
 * Local pixel evidence: is the content at this zone in the live frame the same as on the reference
 * page? Normalised cross-correlation over the zone, ignoring pixels hidden by the pointer.
 */
export function verifyLocal(live, refSmooth, H, box, pointerMask = null) {
  const step = Math.max(1, Math.min(box.width, box.height) / 22), a = [], b = [];
  let total = 0;
  for (let y = box.y + step / 2; y < box.y + box.height; y += step) for (let x = box.x + step / 2; x < box.x + box.width; x += step) {
    total++;
    const p = project(H, { x, y }); if (!p) continue;
    if (pointerMask) { const mx = Math.round((p.x + 0.5) / pointerMask.work - 0.5), my = Math.round((p.y + 0.5) / pointerMask.work - 0.5); if (mx >= 0 && my >= 0 && mx < pointerMask.w && my < pointerMask.h && pointerMask.mask[my * pointerMask.w + mx]) continue; }
    const lv = sample(live, p.x, p.y), rv = sample(refSmooth, x, y); if (Number.isNaN(lv) || Number.isNaN(rv)) continue;
    a.push(lv); b.push(rv);
  }
  const n = a.length, visible = total ? n / total : 0;
  if (n < 12) return { ncc: null, visible, inkStd: 0 };
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  const inkStd = Math.sqrt(sbb / n);
  return { ncc: saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : null, visible, inkStd };
}
