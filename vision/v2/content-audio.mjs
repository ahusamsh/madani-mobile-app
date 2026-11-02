// Unified content layer: recognised zone -> canonical content id -> kind -> ORIGINAL audio clip.
// Never invents audio: a zone without a mapped clip is 'unmapped'; a mapped clip whose file cannot be
// loaded becomes 'missing-file' at play time (AudioController). Coverage is reported, not assumed.
import { resolveAudio } from '../engine/target.mjs';

/** Original full-page recording. Never mislabel this as a word/letter recording. */
export function resolvePageAudio(library, pageId) {
  const p = library.pages?.[pageId];
  if (!p) return null;
  if (p.localAudio) return p.localAudio;
  if (p.audioSourceCached && pageId > 2) return './library-audio/page-' + String(pageId - 2).padStart(3, '0') + '.mp3';
  return null;
}

const HARAKAT = /[ً-ْٰٕٓٔ]/u;          // tanween, fatha/damma/kasra, shadda, sukun, madda, hamza marks, dagger alef
const IGNORE = /[ـ\s‌‍ۖ-ۭؐ-ؚ]/gu; // tatweel, joiners, Quranic annotation marks
const BASE = /[ء-غف-يٱ-ۓ]/gu;          // Arabic base letters

/**
 * 'letter'   — one bare base letter, any positional form (ب, بـ, ـبـ, ـب)
 * 'syllable' — one base letter carrying harakat / tanween / shadda / sukun / madd (بَ, بٌ, بّ, آ counts as letter+madd)
 * 'word'     — two or more base letters
 */
export function contentKind(text) {
  const t = String(text ?? '').replace(IGNORE, ''), bases = t.match(BASE) || [];
  if (bases.length >= 2) return 'word';
  if (bases.length === 1) return HARAKAT.test(t) || bases[0] === 'آ' ? 'syllable' : 'letter';
  return 'unknown';
}

export const KIND_LABEL_AR = { letter: 'حرف', syllable: 'مقطع', word: 'كلمة', unknown: 'موضع' };

/** Canonical description of a recognised zone and its audio status. */
export function resolveContent(library, pageId, zone) {
  const audio = resolveAudio(library, pageId, zone);
  return {
    contentId: zone.id, pageId, text: zone.text, spokenText: zone.spokenText ?? null, kind: contentKind(zone.text),
    reviewed: !!zone.reviewed, geometryReviewed: !!zone.geometryReviewed,
    audio: audio ? { ...audio, segmentStatus: audio.status, status: 'available' } : { status: 'unmapped' },
  };
}

/** Real coverage of the library (optionally checking clip files exist via `exists(path)`). */
export function audioCoverage(library, exists = null) {
  const pages = [], totals = { pages: 0, pagesWithZones: 0, zones: 0, mapped: 0, missingFiles: 0, reviewedClips: 0, byKind: {} };
  for (const [id, p] of Object.entries(library.pages || {})) {
    totals.pages++;
    const zones = p.zones || []; if (!zones.length) continue; totals.pagesWithZones++;
    let mapped = 0, missing = 0, reviewed = 0;
    for (const z of zones) {
      const c = resolveContent(library, Number(id), z), k = (totals.byKind[c.kind] ??= { zones: 0, mapped: 0 });
      k.zones++; totals.zones++;
      if (c.audio.status === 'available') {
        if (exists && !exists(c.audio.clip)) { missing++; continue; }
        mapped++; k.mapped++; if (c.audio.reviewed) reviewed++;
      }
    }
    totals.mapped += mapped; totals.missingFiles += missing; totals.reviewedClips += reviewed;
    pages.push({ pageId: Number(id), zones: zones.length, mapped, missingFiles: missing, zoneStatus: p.zoneStatus ?? null, audioStatus: p.audioStatus ?? null });
  }
  return { totals, pages: pages.filter(p => p.mapped || p.missingFiles), unmappedPages: pages.filter(p => !p.mapped).map(p => p.pageId) };
}
