// SIMULATED benchmark on REAL page images (browser). NOT real-camera validation.
import { VisionEngine } from '../engine/engine.mjs';
import { referencePages, loadGray } from '../engine/browser-refs.mjs';
import { runScenarios } from './scenarios.mjs';

const APP_ROOT = new URL('../../', import.meta.url), params = new URLSearchParams(location.search);
const out = (s) => { document.getElementById('log').textContent += s + '\n'; };

async function main() {
  const t0 = performance.now();
  const library = await (await fetch(new URL('data/audio-library.json', APP_ROOT))).json();
  const refs = referencePages(library, APP_ROOT), grays = new Map(), engine = new VisionEngine({ library });
  for (const r of refs) { const g = await loadGray(r.url); grays.set(r.pageId, g); engine.addReferencePage(r.pageId, g); }
  const indexMs = performance.now() - t0; out(`indexed ${refs.length} real pages in ${indexMs | 0} ms`);
  const testPages = (params.get('pages') || '17,18,19,20,21').split(',').map(Number), perPage = +(params.get('zones') || 3);
  const res = runScenarios({ engine, library, grays, testPages, perPage, log: out, indexMs, environment: navigator.userAgent });
  window.__bench = res; out(JSON.stringify(res.summary, null, 2));
}
if (!params.has('noRun')) main().catch(e => { window.__bench = { error: String(e.stack || e) }; out(String(e.stack || e)); });

/**
 * SIMULATED fake-camera video (Y4M, I420) rendered from a real page image with a pointer on one zone.
 * Used by run-bench.cjs to drive camera-trial.html through Chromium's fake capture device.
 */
window.__makeFakeCamera = async (pageId, zoneId, { frames = 90, still = 20, w = 640, h = 480, type = 'pen' } = {}) => {
  const { poseHomography, renderFrame } = await import('../engine/synth.mjs');
  const library = await (await fetch(new URL('data/audio-library.json', APP_ROOT))).json();
  const ref = referencePages(library, APP_ROOT).find(r => r.pageId === pageId), g = await loadGray(ref.url);
  const z = library.pages[pageId].zones.find(z => z.id === zoneId), tipPage = { x: (z.box[0] + z.box[2] * 0.5) * g.w, y: (z.box[1] + z.box[3] * 0.78) * g.h };
  const H = poseHomography(g, { frameW: w, frameH: h, pageWidthInFrame: 1.15, rotationDeg: 6, center: [0.5, Math.min(0.8, tipPage.y / g.h + 0.08)] });
  const header = new TextEncoder().encode(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420jpeg\n`), fh = new TextEncoder().encode('FRAME\n');
  const size = w * h * 1.5, out = new Uint8Array(header.length + frames * (fh.length + size)); out.set(header); let o = header.length;
  for (let f = 0; f < frames; f++) {
    const fr = renderFrame(g, H, { frameW: w, frameH: h, seed: f, noise: 3, pointer: f < still ? null : { type, tipPage, angleDeg: 80 } }), p = fr.rgba;
    out.set(fh, o); o += fh.length;
    for (let i = 0; i < w * h; i++) out[o + i] = 0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2];
    const U = o + w * h, V = U + (w * h) / 4;
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w / 2; x++) {
      const k = (2 * y * w + 2 * x) * 4, r = p[k], gg = p[k + 1], b = p[k + 2], q = y * (w / 2) + x;
      out[U + q] = Math.max(0, Math.min(255, 128 - 0.1687 * r - 0.3313 * gg + 0.5 * b)); out[V + q] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.4187 * gg - 0.0813 * b));
    }
    o += size;
  }
  let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return { b64: btoa(s), expectedClip: library.segments[zoneId]?.clip ?? null, text: z.text };
};
