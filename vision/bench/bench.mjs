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
main().catch(e => { window.__bench = { error: String(e.stack || e) }; out(String(e.stack || e)); });
