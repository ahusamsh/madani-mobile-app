// Baseline vs V2 comparison on identical SIMULATED frame sequences rendered from the REAL page images.
// Frames are synthetic (perspective, light, noise, drawn pointers): NOT real-camera validation.
import { poseHomography, renderFrame, rng, proceduralPage } from '../engine/synth.mjs';

const FRAME_MS = 70; // simulated camera period (~14 fps)

/** Scenario factory. Each scenario yields a list of steps {frames, pointer, poseJitter} on one page. */
export function buildScenarios(library, grays, pages, perPage = 3, seed = 20261102, { truth = null } = {}) {
  // With `truth` (vision/bench/pdf-truth.json pages), tips are placed on the glyph positions from the PDF TEXT LAYER
  // (independent of the zone map) and only zones that have such a position are used.
  const R = rng(seed), out = [];
  const zonesOf = pageId => { const zs = library.pages[pageId].zones; if (!truth) return zs; const byId = new Map(zs.map(z => [z.id, z])); return (truth[pageId]?.truth || []).filter(t => byId.has(t.zoneId)).map(t => ({ ...byId.get(t.zoneId), box: t.box })); };
  const tipOf = (g, z, fy = 0.78, fx = null) => ({ x: (z.box[0] + z.box[2] * (fx ?? (0.35 + 0.3 * R()))) * g.w, y: (z.box[1] + z.box[3] * fy) * g.h });
  for (const pageId of pages) {
    const g = grays.get(pageId), zones = zonesOf(pageId).filter(z => z.box[2] * g.w > (truth ? 5 : 14) && z.box[3] * g.h > 12); if (!zones.length) continue;
    const pick = Array.from({ length: perPage }, (_, i) => zones[Math.floor(((i + 0.5) / perPage) * zones.length)]);
    const center = tip => [0.5, Math.min(0.8, Math.max(0.3, tip.y / g.h + 0.08))];
    for (const z of pick) {
      // `aim`: the user points the camera at the area being pointed at, leaving room on the hand's side
      const base = (name, pointer, extra = {}) => { const tip = pointer.tipPage, c = extra.aim ? [Math.min(0.85, Math.max(0.15, tip.x / g.w + extra.aim[0])), Math.min(0.85, Math.max(0.15, tip.y / g.h + extra.aim[1]))] : center(tip); out.push({ name, pageId, expect: [z.id], steps: [{ frames: 3, pointer: null }, { frames: 10, pointer }], pose: { pageWidthInFrame: 1.15, center: c, ...(extra.pose || {}) }, light: extra.light || {}, ...extra.meta }); };
      base('pen-alone-frontal', { type: 'pen', tipPage: tipOf(g, z), angleDeg: 60 + R() * 60 });
      base('finger+hand-rotated-tilted', { type: 'finger', hand: true, tipPage: tipOf(g, z), angleDeg: 60 + R() * 60 }, { pose: { rotationDeg: 15, tiltX: 0.3 } });
      base('pen+hand-low-light', { type: 'pen', hand: true, tipPage: tipOf(g, z), angleDeg: 70 + R() * 40 }, { pose: { rotationDeg: -8 }, light: { gain: 0.55, gradient: [0.5, 0.3] } });
      base('pointer-from-left', { type: 'finger', hand: true, tipPage: tipOf(g, z, 0.6), angleDeg: 175 }, { aim: [-0.12, 0] });
      base('pointer-from-right', { type: 'pen', tipPage: tipOf(g, z, 0.6), angleDeg: 5 }, { aim: [0.12, 0] });
      base('pointer-from-top', { type: 'pen', tipPage: tipOf(g, z, 0.3), angleDeg: 265 }, { aim: [0, -0.1] });
      base('stress-short-pointer-right', { type: 'pen', tipPage: tipOf(g, z, 0.6), angleDeg: 5 });  // camera not aimed: little pointer visible
      base('light-pen', { type: 'pen', tipPage: tipOf(g, z), angleDeg: 80, color: [200, 200, 208] });
      base('tip-near-line-bottom', { type: 'pen', tipPage: tipOf(g, z, 0.93), angleDeg: 85 });
      // steady hold with hand-held camera shake: expect exactly one trigger, measure tip jitter
      { const tip = tipOf(g, z, 0.75, 0.5); out.push({ name: 'steady-hold-shake', pageId, expect: [z.id], steps: [{ frames: 3, pointer: null }, { frames: 16, pointer: { type: 'finger', hand: true, tipPage: tip, angleDeg: 95 }, shake: true }], pose: { pageWidthInFrame: 1.15, center: center(tip) }, light: {} }); }
    }
    // move to the adjacent word in the same row without lifting
    const byRow = {}; for (const z of zonesOf(pageId)) (byRow[z.row] ??= []).push(z);
    let moves = 0;
    for (const row of Object.values(byRow)) {
      if (moves >= 2) break;
      row.sort((a, b) => a.box[0] - b.box[0]);
      for (let i = 0; i + 1 < row.length && moves < 2; i++) {
        const a = row[i], b = row[i + 1]; if (a.box[2] * g.w < (truth ? 5 : 14) || b.box[2] * g.w < (truth ? 5 : 14)) continue;
        if (zonesOf(pageId).some(o => o.id !== a.id && o.id !== b.id && o !== a && o !== b && o.box[1] < a.box[1] + a.box[3] && o.box[1] + o.box[3] > a.box[1] && o.box[0] < b.box[0] + b.box[2] && o.box[0] + o.box[2] > a.box[0] && (o.box[0] > a.box[0] + a.box[2] - 1 && o.box[0] + o.box[2] < b.box[0] + 1))) continue;
        moves++; const ta = tipOf(g, a, 0.75, 0.5), tb = tipOf(g, b, 0.75, 0.5);
        out.push({ name: 'move-between-adjacent-words', pageId, expect: [b.id, a.id].sort() && [a.id, b.id], steps: [{ frames: 3, pointer: null }, { frames: 8, pointer: { type: 'pen', tipPage: ta, angleDeg: 80 } }, { frames: 8, pointer: { type: 'pen', tipPage: tb, angleDeg: 80 } }], pose: { pageWidthInFrame: 1.15, center: center(ta) }, light: {} });
      }
    }
    out.push({ name: 'no-pointer', pageId, expect: [], steps: [{ frames: 12, pointer: null }], pose: { pageWidthInFrame: 1.3, rotationDeg: 12, center: [0.45, 0.55] }, light: { shadow: { x: 240, y: 200, r: 140, depth: 0.4 } } });
  }
  out.push({ name: 'unknown-page', pageId: 'procedural', expect: [], steps: [{ frames: 10, pointer: { type: 'pen', tipPage: { x: 200, y: 300 }, angleDeg: 80 } }], pose: { pageWidthInFrame: 1.15 }, light: {} });
  return out;
}

/** Run every scenario through one engine. Returns per-scenario rows + summary. */
export function runCompare(engine, scenarios, grays, { log = () => {}, sourceGrays = null } = {}) {
  // sourceGrays: images the CAMERA sees (e.g. pdf.js renders of books/ar.pdf), independent of the engine's references
  const rows = [], frameMs = [], stranger = proceduralPage({ seed: 4242 }).gray;
  let clock = 0;
  for (const sc of scenarios) {
    engine.reset();
    const scSeed = [...`${sc.name}|${sc.pageId}|${sc.expect.join()}`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7) & 0xffff;
    const g = sc.pageId === 'procedural' ? stranger : (sourceGrays?.get(sc.pageId) ?? grays.get(sc.pageId)), H0 = poseHomography(g, sc.pose), R = rng(scSeed + 1);
    const accepted = [], pageIds = [], tips = []; let pointerStart = null, firstAcceptLatency = null, frameNo = 0;
    for (const step of sc.steps) for (let i = 0; i < step.frames; i++) {
      clock += FRAME_MS; frameNo++;
      const H = step.shake ? poseHomography(g, { ...sc.pose, rotationDeg: (sc.pose.rotationDeg || 0) + (R() - 0.5) * 2, center: [sc.pose.center?.[0] ?? 0.5 + (R() - 0.5) * 0.01, (sc.pose.center?.[1] ?? 0.5) + (R() - 0.5) * 0.01] }) : H0;
      const f = renderFrame(g, H, { pointer: step.pointer, light: sc.light, seed: frameNo * 31 + scSeed, noise: 3 });
      if (step.pointer && pointerStart === null) pointerStart = clock;
      const t = performance.now(), r = engine.processFrame({ rgba: f.rgba, width: f.width, height: f.height, at: clock }), dt = performance.now() - t; frameMs.push(dt);
      if (r.pageId != null) pageIds.push(r.pageId);
      if (step.shake && r.tip?.page) tips.push(r.tip.page);
      if (r.accepted) { accepted.push(r.targetId); if (firstAcceptLatency === null && pointerStart !== null) firstAcceptLatency = clock - pointerStart + dt; }
    }
    const correct = sc.expect.length ? accepted.filter(id => sc.expect.includes(id)).length : 0, wrong = accepted.filter(id => !sc.expect.includes(id)).length;
    const pageWrong = sc.pageId === 'procedural' ? pageIds.length : pageIds.filter(p => p !== sc.pageId).length;
    let jitter = null; if (tips.length > 3) { const t = tips.slice(2), mx = t.reduce((s, p) => s + p.x, 0) / t.length, my = t.reduce((s, p) => s + p.y, 0) / t.length; jitter = Math.sqrt(t.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / t.length); }
    const ok = sc.expect.length ? sc.expect.every(id => accepted.includes(id)) && !wrong && (sc.name !== 'move-between-adjacent-words' || accepted.indexOf(sc.expect[0]) < accepted.lastIndexOf(sc.expect[1])) : accepted.length === 0;
    rows.push({ name: sc.name, pageId: sc.pageId, expect: sc.expect, accepted, correct, wrong, ok, duplicates: sc.expect.length ? accepted.length - new Set(accepted).size : 0, pageFrames: pageIds.length, pageWrong, firstAcceptLatencyMs: firstAcceptLatency, tipJitterPx: jitter });
  }
  log(`${engine.version || 'baseline'} done`);
  return { rows, summary: summarize(rows, frameMs) };
}

function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); }
export function summarize(rows, frameMs) {
  const targets = rows.filter(r => r.expect.length), none = rows.filter(r => !r.expect.length);
  const byName = {}; for (const r of rows) { const b = (byName[r.name] ??= { n: 0, ok: 0, wrong: 0 }); b.n++; b.ok += r.ok ? 1 : 0; b.wrong += r.wrong; }
  const lat = targets.map(r => r.firstAcceptLatencyMs).filter(v => v !== null), jit = rows.map(r => r.tipJitterPx).filter(v => v !== null);
  const pageFrames = rows.reduce((s, r) => s + r.pageFrames, 0), pageWrong = rows.reduce((s, r) => s + r.pageWrong, 0);
  return {
    label: 'SIMULATED frames from real page images — not real-camera validation',
    scenarios: rows.length, targetScenariosOk: targets.filter(r => r.ok).length, targetScenarios: targets.length,
    wordCorrectTriggers: targets.reduce((s, r) => s + r.correct, 0), wordWrongTriggers: rows.reduce((s, r) => s + r.wrong, 0),
    noPointerOrUnknownFalseTriggers: none.reduce((s, r) => s + r.accepted.length, 0), duplicateTriggers: targets.reduce((s, r) => s + r.duplicates, 0),
    pageFramesIdentified: pageFrames, pageFramesWrong: pageWrong,
    timeToSpeakMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), n: lat.length, note: 'from pointer appearance to accepted target at 14 fps simulated + processing' },
    tipJitterRefPx: { mean: jit.length ? +(jit.reduce((a, b) => a + b, 0) / jit.length).toFixed(2) : null, note: '640px-wide page ≈ 3.8 px per mm' },
    frameProcessingMs: { p50: pct(frameMs, 0.5), p95: pct(frameMs, 0.95), frames: frameMs.length },
    byScenario: byName,
  };
}
