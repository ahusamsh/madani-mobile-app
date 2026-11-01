// SYNTHETIC end-to-end tests (procedural pages + simulated camera). Not real-camera validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisionEngine } from './engine.mjs';
import { proceduralPage, poseHomography, renderFrame } from './synth.mjs';

const PAGES = [31, 32, 33, 34, 35, 36];
const built = new Map(PAGES.map((id, i) => [id, proceduralPage({ seed: 100 + i })]));
const library = { pages: {}, segments: {} };
for (const [id, p] of built) {
  library.pages[id] = { zones: p.words.map(wd => ({ id: `p${id}-${wd.id}`, text: wd.text, box: wd.box, kind: 'word', geometryReviewed: true })), boxes: [] };
  // every word has audio except column 3 (to test "no mapping => silent")
  for (const wd of p.words) if (wd.col !== 3) library.segments[`p${id}-${wd.id}`] = { clip: `./library-clips/p${id}-${wd.id}.mp3`, page: id, start: 0, end: 1 };
}
const engine = new VisionEngine({ library });
for (const [id, p] of built) engine.addReferencePage(id, p.gray);

const wordTip = (page, row, col, fy = 0.85) => { const wd = built.get(page).words.find(w => w.row === row && w.col === col), g = built.get(page).gray; return { x: (wd.box[0] + wd.box[2] * 0.5) * g.w, y: (wd.box[1] + wd.box[3] * fy) * g.h }; };
let clock = 0;
function run(page, frames, { pose = {}, pointer = null, light = {}, seed = 1 } = {}) {
  const ref = built.get(page).gray, H = poseHomography(ref, pose), out = [];
  for (let i = 0; i < frames; i++) { clock += 70; const f = renderFrame(ref, H, { pointer, light, seed: seed + i, noise: 3 }); out.push(engine.processFrame({ rgba: f.rgba, width: f.width, height: f.height, at: clock })); }
  return out;
}
const accepted = rs => rs.filter(r => r.accepted);
const lift = (page, n = 5) => run(page, n);

test('no pointer => zero accepted results and zero audio', () => {
  engine.reset();
  const rs = run(31, 14, { pose: { rotationDeg: 8 } });
  assert.equal(accepted(rs).length, 0);
  assert.ok(rs.some(r => r.pageId === 31), 'page should still be identified');
  assert.ok(rs.every(r => !r.play));
});

test('pen alone (no hand) on a word => that whole word once, with its existing clip', () => {
  engine.reset(); run(32, 4);
  const rs = run(32, 10, { pointer: { type: 'pen', tipPage: wordTip(32, 3, 1), angleDeg: 65 } });
  const a = accepted(rs);
  assert.equal(a.length, 1, JSON.stringify(rs.map(r => r.rejectionReason)));
  assert.equal(a[0].targetId, 'p32-w3-1'); assert.equal(a[0].pointerType, 'pen'); assert.equal(a[0].kind, 'word');
  assert.equal(a[0].audio.clip, './library-clips/p32-w3-1.mp3'); assert.equal(a[0].play, true);
  for (const k of ['pageId', 'targetText', 'kind', 'tip', 'confidence', 'sourceEvidence', 'rejectionReason']) assert.ok(k in a[0], k);
});

test('index finger with hand => correct word; sustained hold speaks once; lift and re-point speaks again', () => {
  engine.reset(); run(33, 4);
  const pointer = { type: 'finger', tipPage: wordTip(33, 5, 2), angleDeg: 95, hand: true };
  const held = run(33, 16, { pointer });
  assert.equal(accepted(held).length, 1, JSON.stringify(held.map(r => r.rejectionReason)));
  assert.equal(accepted(held)[0].targetId, 'p33-w5-2'); assert.equal(accepted(held)[0].pointerType, 'finger');
  lift(33, 5);
  const again = run(33, 8, { pointer });
  assert.equal(accepted(again).length, 1);
});

test('rotated, tilted, partial page (top/side cut off) still targets the right word', () => {
  engine.reset(); const pose = { rotationDeg: -18, tiltX: 0.35, pageWidthInFrame: 1.35, center: [0.42, 0.62] };
  run(34, 4, { pose });
  const a = accepted(run(34, 10, { pose, pointer: { type: 'pen', tipPage: wordTip(34, 6, 1), angleDeg: 50 } }));
  assert.equal(a.length, 1); assert.equal(a[0].targetId, 'p34-w6-1');
});

test('tip in the gap between two words or in the margin => no output', () => {
  engine.reset(); run(35, 4);
  const p = built.get(35), a = p.words.find(w => w.row === 2 && w.col === 1), b = p.words.find(w => w.row === 2 && w.col === 2);
  const gapX = ((a.box[0] + a.box[2] + b.box[0]) / 2) * p.gray.w, y = (a.box[1] + a.box[3] * 0.5) * p.gray.h;
  assert.equal(accepted(run(35, 8, { pointer: { type: 'pen', tipPage: { x: gapX, y }, angleDeg: 80 } })).length, 0);
  lift(35);
  assert.equal(accepted(run(35, 8, { pointer: { type: 'pen', tipPage: { x: p.gray.w * 0.03, y: p.gray.h * 0.5 }, angleDeg: 80 } })).length, 0);
});

test('word without an audio mapping is recognised but stays silent', () => {
  engine.reset(); run(36, 4);
  const a = accepted(run(36, 10, { pointer: { type: 'pen', tipPage: wordTip(36, 4, 3), angleDeg: 70 } }));
  assert.equal(a.length, 1); assert.equal(a[0].targetId, 'p36-w4-3');
  assert.equal(a[0].play, false); assert.equal(a[0].audio, null); assert.equal(a[0].rejectionReason, 'no-audio-mapping');
});

test('very dark frame => weak-camera reason, never a target', () => {
  engine.reset();
  const rs = run(31, 8, { light: { gain: 0.08 }, pointer: { type: 'pen', tipPage: wordTip(31, 2, 2), angleDeg: 70 } });
  assert.equal(accepted(rs).length, 0);
  assert.ok(rs.some(r => String(r.rejectionReason).startsWith('weak-camera')), JSON.stringify(rs.map(r => r.rejectionReason)));
});

test('a page that is not in the index => no page, no target, no audio', () => {
  engine.reset();
  const stranger = proceduralPage({ seed: 999 }), H = poseHomography(stranger.gray, {});
  for (let i = 0; i < 8; i++) {
    clock += 70; const f = renderFrame(stranger.gray, H, { pointer: { type: 'pen', tipPage: { x: 200, y: 300 }, angleDeg: 70 }, seed: i });
    const r = engine.processFrame({ rgba: f.rgba, width: f.width, height: f.height, at: clock });
    assert.equal(r.accepted, false); assert.equal(r.play, false);
  }
});
