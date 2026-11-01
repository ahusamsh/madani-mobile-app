// Unit tests. Image tests use SYNTHETIC frames; audio-link tests use the REAL data/audio-library.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proceduralPage, poseHomography, renderFrame } from './synth.mjs';
import { fromRGBA, frameQuality } from './image.mjs';
import { computeFeatures, fitHomography, ransacHomography, plausibleHomography } from './features.mjs';
import { PageIndex, LIVE_FEATURE_OPTS } from './page-matcher.mjs';
import { detectPointer } from './pointer.mjs';
import { kindOf, safeClip, resolveAudio, zoneTokens, verifyLocal } from './target.mjs';
import { project, chooseTarget } from '../recognition-core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const library = JSON.parse(readFileSync(root + 'data/audio-library.json', 'utf8'));
const page = proceduralPage({ seed: 4 }), ref = page.gray;
const frame = (pose, opts = {}) => { const H = poseHomography(ref, pose), f = renderFrame(ref, H, { noise: 3, ...opts }); return { H, f, g: fromRGBA(f.rgba, f.width, f.height) }; };

test('homography fit recovers an exact projective map', () => {
  const H = [1.2, 0.1, 30, -0.05, 0.9, 12, 0.0004, -0.0002, 1], src = [[0, 0], [400, 10], [380, 600], [20, 640], [200, 300], [90, 500]].map(([x, y]) => ({ x, y }));
  const F = fitHomography(src, src.map(p => project(H, p)));
  for (const p of src) { const a = project(H, p), b = project(F, p); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6); }
});

test('RANSAC rejects 60% outliers; mirrored / collapsed registrations are implausible', () => {
  const H = [0.8, 0.2, 40, -0.2, 0.8, 90, 0, 0, 1], src = [], dst = [];
  for (let i = 0; i < 100; i++) { const p = { x: (i * 37) % 400, y: (i * 91) % 600 }; src.push(p); dst.push(i % 5 < 2 ? project(H, p) : { x: (i * 53) % 480, y: (i * 29) % 360 }); }
  const r = ransacHomography(src, dst, { threshold: 2 });
  assert.ok(r && r.inliers >= 40 && r.inliers <= 42, String(r?.inliers));
  assert.equal(plausibleHomography([-1, 0, 400, 0, 1, 0, 0, 0, 1], 400, 600), false);
  assert.equal(plausibleHomography([0.001, 0, 0, 0, 0.001, 0, 0, 0, 1], 400, 600), false);
});

test('page index identifies a partial, rotated, tilted view and refuses an unknown page', () => {
  const idx = new PageIndex(); for (let s = 1; s <= 6; s++) idx.addPage(s, proceduralPage({ seed: s }).gray);
  const p3 = proceduralPage({ seed: 3 }).gray, H = poseHomography(p3, { rotationDeg: 28, tiltX: 0.3, pageWidthInFrame: 1.5, center: [0.6, 0.25] });
  const f = renderFrame(p3, H, { noise: 4 }), r = idx.identify(computeFeatures(fromRGBA(f.rgba, f.width, f.height), LIVE_FEATURE_OPTS));
  assert.equal(r.page, 3);
  const c = project(r.registration, { x: 200, y: 150 }), e = project(H, { x: 200, y: 150 });
  assert.ok(Math.hypot(c.x - e.x, c.y - e.y) < 2.5);
  const u = proceduralPage({ seed: 77 }).gray, fu = renderFrame(u, poseHomography(u, {}), {});
  assert.equal(idx.identify(computeFeatures(fromRGBA(fu.rgba, fu.width, fu.height), LIVE_FEATURE_OPTS)).page, null);
});

const tip = { x: 230, y: 300 };
const cases = [
  ['no pointer', null, {}, null],
  ['black pen alone (no hand)', { type: 'pen', tipPage: tip, angleDeg: 65 }, {}, 'pen'],
  ['pencil', { type: 'pencil', tipPage: tip, angleDeg: 115 }, {}, 'pen'],
  ['pen in hand', { type: 'pen', tipPage: tip, angleDeg: 55, hand: true }, {}, 'pen'],
  ['index finger', { type: 'finger', tipPage: tip, angleDeg: 95 }, {}, 'finger'],
  ['finger with hand, low light', { type: 'finger', tipPage: tip, angleDeg: 80, hand: true }, { light: { gain: 0.5 } }, 'finger'],
  ['pen with cast shadow', { type: 'pen', tipPage: tip, angleDeg: 70, castShadow: true }, {}, 'pen'],
  ['no pointer, dark shadow + gradient', null, { light: { shadow: { x: 220, y: 170, r: 120, depth: 0.45 }, gradient: [0.5, 0.4] } }, null],
  ['no pointer, glare', null, { light: { glare: { x: 250, y: 150, r: 90 } } }, null],
];
for (const pose of [{}, { rotationDeg: 22, tiltX: 0.4, pageWidthInFrame: 1.45, center: [0.45, 0.45] }]) {
  for (const [name, pointer, opts, want] of cases) test(`pointer: ${name} ${pose.rotationDeg ? '(rotated/tilted)' : ''}`, () => {
    const { H, f, g } = frame(pose, { pointer, ...opts }), r = detectPointer(g, ref, H, { rgba: f.rgba });
    assert.equal(r.type, want, JSON.stringify({ reason: r.reason, ev: r.evidence }));
    if (want) assert.ok(Math.hypot(r.tip.x - f.tipFrame.x, r.tip.y - f.tipFrame.y) < 6, `tip error ${Math.hypot(r.tip.x - f.tipFrame.x, r.tip.y - f.tipFrame.y)}`);
  });
}

test('pointer whose tip leaves the frame is not used', () => {
  const { H, f, g } = frame({}, { pointer: { type: 'pen', tipPage: { x: 230, y: 30 }, angleDeg: 80 } });
  const r = detectPointer(g, ref, H, { rgba: f.rgba });
  assert.notEqual(r.type, 'pen'); // tip at y<0 in frame -> tip-out-of-frame
});

test('frame quality distinguishes weak camera', () => {
  assert.equal(frameQuality(frame({}, { light: { gain: 0.08 } }).g).weak, 'weak-camera-dark');
  const flat = { w: 100, h: 80, d: new Float32Array(8000).fill(128) };
  assert.equal(frameQuality(flat).weak, 'weak-camera-low-contrast');
  assert.equal(frameQuality(frame({}).g).weak, null);
});

test('local evidence: right registration correlates, wrong registration does not', () => {
  const { H, g } = frame({}), wd = page.words[10], box = { x: wd.box[0] * ref.w, y: wd.box[1] * ref.h, width: wd.box[2] * ref.w, height: wd.box[3] * ref.h };
  const good = verifyLocal(g, ref, H, box), shifted = verifyLocal(g, ref, [H[0], H[1], H[2] + 25, H[3], H[4], H[5] + 9, H[6], H[7], H[8]], box);
  assert.ok(good.ncc > 0.7, String(good.ncc)); assert.ok(shifted.ncc < 0.45, String(shifted.ncc));
});

test('kindOf: isolated letters with tatweel/harakat are letters, words are words', () => {
  for (const t of ['ب', 'بـ', 'ـبـ', 'ـب', 'بَ', 'بِّ', 'ٱ']) assert.equal(kindOf({ text: t }), 'letter', t);
  for (const t of ['بِسْمِ', 'اللّٰهِ', 'كَتَبَ']) assert.equal(kindOf({ text: t }), 'word', t);
  assert.equal(kindOf({ text: 'بِسْمِ', kind: 'letter' }), 'letter');
});

test('pointing anywhere inside a word selects the whole word; diacritic zones above are not neighbours', () => {
  const tokens = [{ id: 'w1', text: 'بِسْمِ', confidence: 0.9, box: { x: 100, y: 100, width: 60, height: 30 } }, { id: 'w2', text: 'اللّٰهِ', confidence: 0.9, box: { x: 30, y: 100, width: 60, height: 30 } }];
  for (const x of [102, 130, 158]) assert.equal(chooseTarget({ x, y: 120 }, tokens).target.id, 'w1');
  assert.equal(chooseTarget({ x: 95, y: 120 }, tokens).target, null); // the 10px gap between words
  assert.equal(chooseTarget({ x: 130, y: 60 }, tokens).target, null);  // well above the line
});

test('safeClip mirrors app.js and blocks traversal / remote URLs', () => {
  assert.equal(safeClip('./pilot-media/p015-word-001.mp3'), './pilot-media/p015-word-001.mp3');
  for (const bad of ['../x.mp3', 'https://evil/x.mp3', '/etc/x.mp3', 'javascript:x', './a/b.txt', null]) assert.equal(safeClip(bad), null, String(bad));
});

test('REAL library: every mapped zone resolves to an existing clip file of the same page', () => {
  let resolved = 0;
  for (const [pid, pg] of Object.entries(library.pages)) for (const z of pg.zones) {
    const a = resolveAudio(library, Number(pid), z); if (!a) continue; resolved++;
    assert.ok(existsSync(root + a.clip.slice(2)), a.clip);
    assert.equal(library.segments[z.id]?.page ?? Number(pid), Number(pid));
  }
  assert.equal(resolved, Object.keys(library.segments).length, 'each segment should be reachable from exactly one zone');
});

test('REAL library: page 17 isolated letter ا maps to its own clip; unmapped page stays silent', () => {
  const z = library.pages['17'].zones.find(z => z.id === 'p17-w1');
  const a = resolveAudio(library, 17, z);
  assert.equal(a.clip, './pilot-media/p015-word-001.mp3'); assert.equal(kindOf(z), 'letter');
  const z7 = library.pages['7'].zones[0]; assert.equal(resolveAudio(library, 7, z7), null);
  assert.equal(resolveAudio(library, 18, z), null, 'a segment must belong to the same page');
  const toks = zoneTokens(library, 20, 640, 903);
  assert.ok(toks.length === library.pages['20'].zones.length && toks.every(t => t.box.width > 0));
});

test('a target hidden under the pointer has no visible evidence (engine rejects it as target-occluded)', () => {
  const { H, g } = frame({}), wd = page.words[10], box = { x: wd.box[0] * ref.w, y: wd.box[1] * ref.h, width: wd.box[2] * ref.w, height: wd.box[3] * ref.h };
  const work = 2, mw = Math.round(g.w / work), mh = Math.round(g.h / work), mask = new Uint8Array(mw * mh).fill(1);
  const ev = verifyLocal(g, ref, H, box, { mask, w: mw, h: mh, work });
  assert.ok(ev.visible < 0.3, String(ev.visible));
});
