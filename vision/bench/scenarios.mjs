// SIMULATED scenario runner shared by the browser bench and Node experiments.
// Frames are synthesised from REAL page images; this is NOT real-camera validation.
import { poseHomography, renderFrame, rng } from '../engine/synth.mjs';

export const SCENARIOS = [
  { name: 'pen-alone-frontal', pointer: { type: 'pen' }, pose: {} },
  { name: 'finger+hand-rotated-tilted', pointer: { type: 'finger', hand: true }, pose: { rotationDeg: 15, tiltX: 0.3 } },
  { name: 'pencil-partial-zoom', pointer: { type: 'pencil' }, pose: { pageWidthInFrame: 1.7, focus: true } },
  { name: 'pen+hand-low-light', pointer: { type: 'pen', hand: true }, pose: { rotationDeg: -8 }, light: { gain: 0.55, gradient: [0.5, 0.3] } },
  { name: 'stress-tip-near-frame-edge', pointer: { type: 'finger', hand: true }, pose: { edge: true } },
  { name: 'finger-shadow-glare', pointer: { type: 'finger', castShadow: true }, pose: { tiltX: -0.25 }, light: { shadow: { x: 120, y: 90, r: 110, depth: 0.35 }, glare: { x: 420, y: 60, r: 70 } } },
];


/** engine: VisionEngine with all reference pages indexed; grays: Map pageId -> gray ref image. */
export function runScenarios({ engine, library, grays, testPages = [17, 18, 19, 20, 21], perPage = 3, log = () => {}, indexedPages = grays.size, indexMs = null, environment = '' }) {
  const R = rng(20261101), lat = [], rows = [];
  let clock = 0;
  const seq = (pageId, H, frames, pointer, light, seed) => {
    const res = [];
    for (let i = 0; i < frames; i++) {
      clock += 70; const f = renderFrame(grays.get(pageId), H, { pointer: i < 3 ? null : pointer, light, seed: seed + i, noise: 3 });
      const t = performance.now(), r = engine.processFrame({ rgba: f.rgba, width: f.width, height: f.height, at: clock }); lat.push(performance.now() - t); res.push(r);
    }
    return res;
  };
  for (const pageId of testPages) {
    const g = grays.get(pageId), zones = library.pages[pageId].zones.filter(z => z.box[2] * g.w > 14 && z.box[3] * g.h > 12);
    const pick = Array.from({ length: perPage }, (_, i) => zones[Math.floor(((i + 0.5) / perPage) * zones.length)]);
    for (const z of pick) for (const sc of SCENARIOS) {
      engine.reset();
      const tipPage = { x: (z.box[0] + z.box[2] * (0.35 + 0.3 * R())) * g.w, y: (z.box[1] + z.box[3] * 0.78) * g.h };
      // the user aims the camera at the area being pointed at (tip slightly above frame centre, hand below)
      const center = sc.pose.edge ? [0.5, 0.5 + 0.15 * (tipPage.y / g.h - 0.5)] : sc.pose.focus ? [tipPage.x / g.w, tipPage.y / g.h + 0.04] : [0.5, Math.min(0.8, Math.max(0.3, tipPage.y / g.h + 0.08))];
      const H = poseHomography(g, { pageWidthInFrame: 1.15, ...sc.pose, center });
      const pointer = { ...sc.pointer, tipPage, angleDeg: 60 + R() * 60 };
      const res = seq(pageId, H, 11, pointer, sc.light || {}, Math.floor(R() * 1e6));
      const acc = res.filter(r => r.accepted);
      rows.push({ kind: 'target', pageId, zone: z.id, text: z.text, scenario: sc.name, accepted: acc.map(a => a.targetId), correct: acc.filter(a => a.targetId === z.id).length, wrong: acc.filter(a => a.targetId !== z.id).length, play: acc.filter(a => a.play).length, reasons: [...new Set(res.map(r => r.rejectionReason).filter(Boolean))] });
    }
    // no pointer at all
    for (const pose of [{}, { rotationDeg: 20, tiltX: 0.35, pageWidthInFrame: 1.5, center: [0.4, 0.6] }]) {
      engine.reset(); const res = seq(pageId, poseHomography(g, { pageWidthInFrame: 1.15, ...pose }), 12, null, { shadow: { x: 240, y: 200, r: 140, depth: 0.4 } }, 7);
      rows.push({ kind: 'no-pointer', pageId, accepted: res.filter(r => r.accepted).map(a => a.targetId), pageFound: res.filter(r => r.pageId === pageId).length });
    }
    // tip between two neighbouring zones on the same row (gap) -> must not speak either neighbour
    const byRow = {}; for (const z of library.pages[pageId].zones) (byRow[z.row] ??= []).push(z);
    let gaps = 0;
    for (const row of Object.values(byRow)) {
      row.sort((a, b) => a.box[0] - b.box[0]);
      for (let i = 0; i + 1 < row.length && gaps < 3; i++) {
        const a = row[i], b = row[i + 1], gap = (b.box[0] - (a.box[0] + a.box[2])) * g.w; if (gap < 10) continue;
        const tipPage = { x: (a.box[0] + a.box[2]) * g.w + gap / 2, y: (a.box[1] + a.box[3] * 0.6) * g.h };
        const covered = library.pages[pageId].zones.some(z => tipPage.x >= z.box[0] * g.w && tipPage.x <= (z.box[0] + z.box[2]) * g.w && tipPage.y >= z.box[1] * g.h && tipPage.y <= (z.box[1] + z.box[3]) * g.h);
        if (covered) continue; // overlapping heuristic zones: not a real gap
        gaps++; engine.reset();
        const res = seq(pageId, poseHomography(g, { pageWidthInFrame: 1.15, center: [0.5, tipPage.y / g.h] }), 11, { type: 'pen', tipPage, angleDeg: 80 }, {}, 11 + gaps);
        rows.push({ kind: 'gap', pageId, between: [a.id, b.id], accepted: res.filter(r => r.accepted).map(r => r.targetId) });
      }
    }
    log(`page ${pageId} done`);
  }
  const T = rows.filter(r => r.kind === 'target'), correct = T.reduce((s, r) => s + r.correct, 0), wrong = T.reduce((s, r) => s + r.wrong, 0);
  const sorted = [...lat].sort((a, b) => a - b), pct = p => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
  const byScenario = Object.fromEntries(SCENARIOS.map(s => { const rs = T.filter(r => r.scenario === s.name); return [s.name, { sequences: rs.length, hit: rs.filter(r => r.correct === 1 && !r.wrong).length, wrong: rs.reduce((a, r) => a + r.wrong, 0) }]; }));
  const summary = {
    label: 'SIMULATED frames rendered from real page images; not real-camera validation',
    environment, indexedPages, indexMs: indexMs === null ? null : Math.round(indexMs),
    targetSequences: T.length, correctTriggers: correct, wrongTriggers: wrong,
    precision: correct + wrong ? +(correct / (correct + wrong)).toFixed(3) : null, recallPerSequence: +(T.filter(r => r.correct >= 1).length / T.length).toFixed(3),
    duplicateTriggersWhileHeld: T.filter(r => r.correct > 1).length,
    noPointerSequences: rows.filter(r => r.kind === 'no-pointer').length, noPointerFalseTriggers: rows.filter(r => r.kind === 'no-pointer').reduce((s, r) => s + r.accepted.length, 0),
    gapSequences: rows.filter(r => r.kind === 'gap').length, gapFalseTriggers: rows.filter(r => r.kind === 'gap').reduce((s, r) => s + r.accepted.length, 0),
    audioPlaysOnCorrect: T.reduce((s, r) => s + r.play, 0),
    frameLatencyMs: { p50: pct(0.5), p95: pct(0.95), frames: lat.length }, byScenario,
  };
  return { summary, rows };
}
