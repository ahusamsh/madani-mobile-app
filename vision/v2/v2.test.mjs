// V2 unit tests: tip tracker, target lock, content kinds/coverage (REAL library), audio controller policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TipTracker, TargetLock } from './engine-v2.mjs';
import { contentKind, resolveContent, audioCoverage } from './content-audio.mjs';
import { AudioController } from './audio-controller.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const library = JSON.parse(readFileSync(root + 'data/audio-library.json', 'utf8'));

test('tip tracker: absorbs jitter, ignores a single-frame outlier, follows a deliberate move at once', () => {
  const t = new TipTracker();
  for (const p of [[100, 100], [101.5, 99], [99, 101], [100.5, 100.5]]) t.update({ x: p[0], y: p[1] });
  assert.ok(Math.hypot(t.smoothed.x - 100, t.smoothed.y - 100) < 1.6);
  const s = t.update({ x: 117, y: 100 }); assert.ok(Math.abs(s.x - 100) < 2, 'one moderate outlier ignored');
  t.update({ x: 100, y: 100 });
  const m = t.update({ x: 160, y: 100 }); assert.equal(m.x, 160, 'big move followed immediately');
});

test('target lock: keeps the word under small jitter at its edge, switches when inside another word', () => {
  const tokens = [{ id: 'a', text: 'كتب', confidence: 0.9, box: { x: 100, y: 100, width: 40, height: 30 } }, { id: 'b', text: 'قلم', confidence: 0.9, box: { x: 150, y: 100, width: 40, height: 30 } }];
  const l = new TargetLock();
  assert.equal(l.select({ x: 120, y: 115 }, tokens, 1).target.id, 'a');
  assert.equal(l.select({ x: 143, y: 115 }, tokens, 1).target.id, 'a', 'just outside a, in the gap: stays a (no flip-flop)');
  assert.equal(l.select({ x: 160, y: 115 }, tokens, 1).target.id, 'b', 'inside b: switch');
  l.reset(); assert.equal(l.select({ x: 145, y: 115 }, tokens, 1).target, null, 'without a lock, the gap stays ambiguous');
});

test('content kinds: bare letter vs syllable (harakat/tanween/shadda/madd) vs word', () => {
  for (const t of ['ب', 'بـ', 'ـبـ', 'ـب', 'ط']) assert.equal(contentKind(t), 'letter', t);
  for (const t of ['بَ', 'بِ', 'بُ', 'بٌ', 'بّ', 'بْ', 'آ', 'إِ']) assert.equal(contentKind(t), 'syllable', t);
  for (const t of ['بِسْمِ', 'كَتَبَ', 'الْقَيُّوم']) assert.equal(contentKind(t), 'word', t);
});

test('REAL library: unified content -> clip, unmapped stays unmapped, coverage is reported truthfully', () => {
  const z = library.pages['17'].zones.find(z => z.id === 'p17-w1'), c = resolveContent(library, 17, z);
  assert.equal(c.kind, 'letter'); assert.equal(c.audio.status, 'available'); assert.equal(c.audio.clip, './pilot-media/p015-word-001.mp3');
  assert.equal(resolveContent(library, 7, library.pages['7'].zones[0]).audio.status, 'unmapped');
  const cov = audioCoverage(library, p => existsSync(root + p.slice(2)));
  assert.equal(cov.totals.mapped, Object.keys(library.segments).length);
  assert.equal(cov.totals.missingFiles, 0);
  assert.deepEqual(cov.pages.map(p => p.pageId).sort((a, b) => a - b), [17, 18, 19, 20, 21]);
  assert.ok(cov.totals.zones > 2000 && cov.totals.mapped < cov.totals.zones, 'most zones have no clip-level audio');
});

// ---- audio controller with fake Web Audio + fetch ----
function fakeEnv({ delays = {}, missing = [] } = {}) {
  const started = [], stopped = [];
  class Ctx {
    constructor() { this.state = 'suspended'; this.sampleRate = 22050; this.destination = {}; }
    async resume() { this.state = 'running'; }
    createBuffer() { return { silent: true }; }
    createBufferSource() { const s = { connect() {}, start() { if (!s.buffer.silent) started.push(s.buffer.clip); }, stop() { stopped.push(s.buffer.clip); } }; return s; }
    decodeAudioData(bytes, ok) { ok({ clip: new TextDecoder().decode(bytes) }); }
  }
  const fetchImpl = async (url) => {
    await new Promise(r => setTimeout(r, delays[url] ?? 1));
    if (missing.includes(url)) return { ok: false };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
  };
  return { started, stopped, ctrl: new AudioController({ AudioContextImpl: Ctx, fetchImpl }) };
}

test('audio: unlock, preload makes playback immediate from memory', async () => {
  const { ctrl, started } = fakeEnv();
  await ctrl.unlock(); assert.equal(ctrl.ctx.state, 'running');
  await ctrl.preload(['a.mp3', 'b.mp3']);
  const r = await ctrl.play('a.mp3'); assert.equal(r.status, 'playing'); assert.equal(r.fromCache, true);
  assert.deepEqual(started, ['a.mp3']);
});

test('audio: a slow old request never plays after a newer one (no stale/overlapping clip)', async () => {
  const { ctrl, started, stopped } = fakeEnv({ delays: { 'slow.mp3': 60, 'fast.mp3': 1 } });
  await ctrl.unlock();
  const p1 = ctrl.play('slow.mp3'), p2 = ctrl.play('fast.mp3');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'cancelled'); assert.equal(r2.status, 'playing'); assert.deepEqual(started, ['fast.mp3']);
  await ctrl.play('slow.mp3'); assert.deepEqual(stopped, ['fast.mp3'], 'moving to a new word stops the previous clip');
});

test('audio: a missing clip file is reported and nothing else is played; disabled sound plays nothing', async () => {
  const events = [], { ctrl, started } = fakeEnv({ missing: ['gone.mp3'] }); ctrl.onEvent = e => events.push(e.type);
  await ctrl.unlock();
  assert.equal((await ctrl.play('gone.mp3')).status, 'missing-file'); assert.deepEqual(started, []); assert.ok(events.includes('missing-file'));
  ctrl.setEnabled(false); assert.equal((await ctrl.play('a.mp3')).status, 'disabled'); assert.deepEqual(started, []);
});

test('reference index: serialize/parse round trip keeps features and thumbnails exactly', async () => {
  const { serializeIndex, parseIndex } = await import('./ref-index.mjs');
  const { proceduralPage } = await import('../engine/synth.mjs');
  const { computeFeatures } = await import('../engine/features.mjs');
  const { REF_FEATURE_OPTS, makeThumb } = await import('../engine/page-matcher.mjs');
  const g = proceduralPage({ seed: 9 }).gray, f = computeFeatures(g, REF_FEATURE_OPTS), t = makeThumb(g);
  const bin = serializeIndex([{ pageId: 5, url: './x.jpg', size: { w: g.w, h: g.h }, features: f, thumb: t }], { version: 1 });
  const p = parseIndex(bin.buffer).pages[0];
  assert.equal(p.pageId, 5); assert.equal(p.features.n, f.n);
  for (const k of ['x', 'y', 'angle', 'level', 'desc']) assert.deepEqual(Array.from(p.features[k]), Array.from(f[k]), k);
  assert.deepEqual(Array.from(p.thumb.d), Array.from(t.d));
});

test('shipped vision/data/ref-index.bin parses and covers every page that has an image and zones', async () => {
  const { parseIndex } = await import('./ref-index.mjs');
  const buf = readFileSync(root + 'vision/data/ref-index.bin'), idx = parseIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const want = Object.entries(library.pages).filter(([, p]) => p.image && p.zones?.length).map(([k]) => +k).sort((a, b) => a - b);
  assert.deepEqual(idx.pages.map(p => p.pageId).sort((a, b) => a - b), want);
  assert.ok(idx.pages.every(p => p.features.n > 200 && p.thumb.w === 200));
});
