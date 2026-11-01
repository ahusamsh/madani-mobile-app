// Browser-only helpers: decode reference page images, cache their features in IndexedDB.
import { computeFeatures } from './features.mjs';
import { REF_FEATURE_OPTS, makeThumb } from './page-matcher.mjs';

export const REF_WIDTH = 640;
const CACHE_VERSION = 'madani-vision-features-v2';

/** Pages that have both an original page image and a zone map in the audio library. */
export function referencePages(library, appRoot) {
  return Object.entries(library.pages || {})
    .filter(([, p]) => typeof p.image === 'string' && Array.isArray(p.zones) && p.zones.length)
    .map(([id, p]) => ({ pageId: Number(id), url: new URL(p.image, appRoot).href, hasAudio: p.zones.some(z => library.segments?.[z.id]) }))
    .sort((a, b) => Number(b.hasAudio) - Number(a.hasAudio) || a.pageId - b.pageId);
}

export async function loadGray(url, width = REF_WIDTH) {
  const blob = await (await fetch(url)).blob(), bmp = await createImageBitmap(blob);
  const h = Math.round((bmp.height * width) / bmp.width), c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, h) : Object.assign(document.createElement('canvas'), { width, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, width, h); bmp.close?.();
  const rgba = ctx.getImageData(0, 0, width, h).data, d = new Uint8ClampedArray(width * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { w: width, h, d };
}

function idb() {
  return new Promise((resolve) => {
    try { const r = indexedDB.open(CACHE_VERSION, 1); r.onupgradeneeded = () => r.result.createObjectStore('f'); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); } catch { resolve(null); }
  });
}
const tx = (db, mode, fn) => new Promise((resolve) => { try { const t = db.transaction('f', mode), req = fn(t.objectStore('f')); t.oncomplete = () => resolve(req?.result ?? null); t.onerror = t.onabort = () => resolve(null); } catch { resolve(null); } });

/** Features for a reference page, from IndexedDB when available (keyed by URL + options version). */
export async function referenceFeatures(ref, db) {
  const key = `${ref.url}|${REF_WIDTH}|${JSON.stringify(REF_FEATURE_OPTS)}`;
  const hit = db && await tx(db, 'readonly', s => s.get(key));
  if (hit?.features?.desc && hit.thumb?.d) return { features: hit.features, size: hit.size, thumb: hit.thumb, gray: null, cached: true };
  const gray = await loadGray(ref.url), features = computeFeatures(gray, REF_FEATURE_OPTS), size = { w: gray.w, h: gray.h }, thumb = makeThumb(gray);
  if (db) await tx(db, 'readwrite', s => s.put({ features, size, thumb }, key));
  return { features, size, thumb, gray, cached: false };
}
export const openFeatureCache = idb;
