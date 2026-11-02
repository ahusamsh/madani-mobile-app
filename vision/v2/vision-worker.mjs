// Vision worker: runs the engine off the UI thread. Page identification (throttled) and pointer tracking
// (every frame) both happen here; the UI only draws and plays audio.
// Messages in : {type:'init', appRoot, engine:'v2'|'v1'} | {type:'frame', id, width, height, buffer|bitmap, at, debug} | {type:'reset'}
// Messages out: {type:'progress'|'ready'|'error'|'result'|'page'}
import { VisionEngineV2 } from './engine-v2.mjs';
import { VisionEngine } from '../engine/engine.mjs';
import { parseIndex } from './ref-index.mjs';
import { resolveContent } from './content-audio.mjs';
import { referencePages, referenceFeatures, loadGray, openFeatureCache } from '../engine/browser-refs.mjs';

let engine = null, library = null, appRoot = null, lastPage = null, canvas = null, ctx = null;
const urls = new Map();
const post = (m, t) => self.postMessage(m, t || []);

async function init({ appRoot: root, engine: which = 'v2' }) {
  const t0 = performance.now(); appRoot = new URL(root);
  library = await (await fetch(new URL('data/audio-library.json', appRoot))).json();
  const Engine = which === 'v1' ? VisionEngine : VisionEngineV2;
  engine = new Engine({ library, loadGray: id => loadGray(urls.get(id)), keepPages: 4 });
  let source = 'precomputed-index';
  try {
    const r = await fetch(new URL('vision/data/ref-index.bin', appRoot)); if (!r.ok) throw new Error('no index');
    const idx = parseIndex(await r.arrayBuffer());
    for (const p of idx.pages) { urls.set(p.pageId, new URL(p.url, appRoot).href); engine.addReferencePage(p.pageId, null, p.features, p.size, p.thumb); }
  } catch {
    source = 'computed-on-device'; // fallback: compute (and cache in IndexedDB) progressively
    const db = await openFeatureCache(), refs = referencePages(library, appRoot); let n = 0;
    for (const ref of refs) { urls.set(ref.pageId, ref.url); const f = await referenceFeatures(ref, db); engine.addReferencePage(ref.pageId, null, f.features, f.size, f.thumb); post({ type: 'progress', done: ++n, total: refs.length }); }
  }
  post({ type: 'ready', pages: engine.index.size, source, ms: Math.round(performance.now() - t0), engine: which });
}

function frame(m) {
  let rgba = m.buffer ? new Uint8ClampedArray(m.buffer) : null;
  if (m.bitmap) {
    if (!canvas || canvas.width !== m.width || canvas.height !== m.height) { canvas = new OffscreenCanvas(m.width, m.height); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    ctx.drawImage(m.bitmap, 0, 0, m.width, m.height); m.bitmap.close(); rgba = ctx.getImageData(0, 0, m.width, m.height).data;
  }
  const t = performance.now(), r = engine.processFrame({ rgba, width: m.width, height: m.height, at: m.at }), procMs = performance.now() - t;
  if (r.pageId !== lastPage && r.pageId != null) { // tell the UI which clips to preload for this page
    lastPage = r.pageId;
    const clips = (library.pages[r.pageId]?.zones || []).map(z => resolveContent(library, r.pageId, z)).filter(c => c.audio.status === 'available').map(c => c.audio.clip);
    post({ type: 'page', pageId: r.pageId, clips });
  }
  const zoneId = r.accepted ? r.targetId : r.candidateId, zone = zoneId && library.pages[r.pageId]?.zones.find(z => z.id === zoneId);
  const content = zone ? resolveContent(library, r.pageId, zone) : null;
  const d = r.debug || {}, transfer = [];
  const slim = { accepted: r.accepted, play: r.play, pageId: r.pageId, targetId: r.targetId, candidateId: r.candidateId ?? null, targetText: r.targetText, kind: content?.kind ?? r.kind, spokenText: r.spokenText ?? content?.spokenText ?? null,
    tip: r.tip, pointerType: r.pointerType, confidence: r.confidence, rejectionReason: r.rejectionReason, audio: r.audio, content,
    quality: { mean: Math.round(r.quality.mean), std: Math.round(r.quality.std), sharpness: Math.round(r.quality.sharpness), weak: r.quality.weak },
    timings: r.timings, sourceEvidence: r.sourceEvidence,
    overlay: { outline: d.outline, accepted: d.accepted?.corners ?? null, candidate: zoneId && !r.accepted ? (d.candidates || []).find(c => c.id === zoneId)?.corners ?? null : null, candidates: m.debug ? d.candidates : null } };
  if (m.debug && d.pointer?.mask) { const mask = d.pointer.mask.slice(); slim.overlay.mask = { w: d.pointer.w, h: d.pointer.h, work: d.pointer.work, mask }; transfer.push(mask.buffer); }
  post({ type: 'result', id: m.id, procMs, result: slim }, transfer);
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'frame') { if (!engine) post({ type: 'result', id: m.id, procMs: 0, result: null }); else frame(m); }
    else if (m.type === 'reset') { engine?.reset(); lastPage = null; }
  } catch (e) { post({ type: 'error', id: m.id, message: String(e?.message || e) }); }
};
