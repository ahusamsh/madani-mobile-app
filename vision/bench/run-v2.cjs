// V2 browser tests (headless Chromium + Playwright):
//  A) online: service worker install, download + verify required offline packs from the UI
//  B) app closed, web server STOPPED, browser relaunched OFFLINE with the same profile:
//     camera-v2 page loads, fake camera (SIMULATED video of real page 17 + pen) -> recognition -> original clip plays;
//     reader opens and renders the Arabic PDF page from the offline pack.
// Usage: NODE_PATH=$(npm root -g) node vision/bench/run-v2.cjs [--zone=p17-w5]
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..', '..'), arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const URL0 = 'http://127.0.0.1:8765';
const startServer = () => new Promise((res, rej) => { const s = spawn(process.execPath, [path.join(root, 'scripts/serve.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] }); s.stdout.on('data', d => String(d).includes('MADANI_SERVER') && res(s)); s.on('exit', c => rej(Error('server exited ' + c))); });

(async () => {
  const { chromium } = require('playwright');
  const out = { generatedAt: new Date().toISOString(), label: 'Headless Chromium on a cloud VM; camera = SIMULATED video from a real page image. Not a phone.', errors: [] };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'madani-v2-')), y4m = path.join(profile, 'cam.y4m');
  let server = await startServer();
  try {
    // fake camera video (rendered from the real page image by the bench page)
    { const b = await chromium.launch(), p = await b.newPage(); await p.goto(URL0 + '/vision/bench/bench.html?noRun=1');
      const fake = await p.evaluate(z => window.__makeFakeCamera(17, z, { frames: 120, still: 25 }), arg('zone') || 'p17-w5'); await b.close();
      fs.writeFileSync(y4m, Buffer.from(fake.b64, 'base64')); out.expected = { zone: arg('zone') || 'p17-w5', clip: fake.expectedClip, text: fake.text }; }
    const launch = () => chromium.launchPersistentContext(profile + '/user', { permissions: ['camera'], args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required'] });

    // ---------- A) online: install + download packs ----------
    let ctx = await launch(), page = await ctx.newPage(); page.on('pageerror', e => out.errors.push('A:' + e.message));
    await page.goto(URL0 + '/vision/camera-v2.html');
    await page.waitForFunction(() => window.__v2?.offline, null, { timeout: 60000 });
    if (!(await page.evaluate(() => navigator.serviceWorker.controller))) { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller && window.__v2?.offline, null, { timeout: 60000 }); }
    out.beforeDownload = await page.evaluate(() => ({ chip: document.querySelector('#offline').textContent, ready: window.__v2.offline.ready }));
    const t0 = Date.now();
    await page.locator('details#packs').evaluate(d => (d.open = true));
    for (const id of ['camera-ar', 'book-ar']) {
      await page.locator(`.pack[data-pack="${id}"] button`, { hasText: 'تنزيل' }).click();
      await page.waitForFunction(i => document.querySelector(`.pack[data-pack="${i}"] small`)?.textContent.includes('✓'), id, { timeout: 300000 });
    }
    await page.waitForFunction(() => window.__v2.offline?.ready, null, { timeout: 60000 });
    out.download = { ms: Date.now() - t0, chip: await page.locator('#offline').textContent(), packs: await page.evaluate(() => window.__v2.offline.packs) };
    // deep integrity check from the UI (re-hash every cached file)
    await page.locator('.pack[data-pack="camera-ar"] button', { hasText: 'تحقق' }).click();
    await page.waitForFunction(() => /سليم|تالف/.test(document.querySelector('.pack[data-pack="camera-ar"] small').textContent), null, { timeout: 120000 });
    out.deepVerify = await page.locator('.pack[data-pack="camera-ar"] small').textContent();
    await page.goto(URL0 + '/'); await page.waitForTimeout(1500); // reader shell visited online once
    await ctx.close();

    // ---------- B) offline: server stopped, browser relaunched offline ----------
    server.kill(); server = null; await new Promise(r => setTimeout(r, 500));
    ctx = await launch(); await ctx.setOffline(true); page = await ctx.newPage(); page.on('pageerror', e => out.errors.push('B:' + e.message));
    const reach = await page.evaluate(() => fetch('http://127.0.0.1:8765/__probe').then(() => 'reachable', () => 'unreachable')).catch(() => 'unreachable');
    await page.goto(URL0 + '/vision/camera-v2.html');
    await page.waitForFunction(() => window.__v2?.offline, null, { timeout: 60000 });
    out.offlineOpen = await page.evaluate(() => ({ onLine: navigator.onLine, chip: document.querySelector('#offline').textContent, ready: window.__v2.offline.ready, sw: !!navigator.serviceWorker.controller }));
    out.offlineOpen.networkProbe = reach;
    const tStart = Date.now(); await page.click('#start');
    await page.waitForFunction(() => window.__v2.audio.some(a => a.clip && !a.missing), null, { timeout: 120000 }).catch(() => {});
    const s = await page.evaluate(() => { const v = window.__v2, q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(p * (s.length - 1))].toFixed(1) : null; }; return { ready: v.ready, accepted: v.accepted, audio: v.audio, results: v.results, procMs: { p50: q(v.procMs, 0.5), p95: q(v.procMs, 0.95), n: v.procMs.length }, pipelineMs: { p50: q(v.pipelineMs, 0.5), p95: q(v.pipelineMs, 0.95) }, errors: v.errors, word: document.querySelector('#word').textContent, status: document.querySelector('#status').textContent }; });
    out.offlineCamera = { ...s, msFromStartClickToFirstAudio: s.audio.length ? Date.now() - tStart : null, pass: s.audio.length > 0 && s.audio.every(a => !a.missing && a.clip === out.expected.clip) && s.accepted.every(a => a.id === out.expected.zone) };
    // reader offline: open book page 17 from the cached Arabic PDF
    const reader = await ctx.newPage(); reader.on('pageerror', e => out.errors.push('reader:' + e.message));
    await reader.goto(URL0 + '/'); await reader.waitForTimeout(1500);
    await reader.evaluate(() => document.querySelector('[data-go=reader]').click()); await reader.waitForTimeout(2500);
    await reader.evaluate(() => { const s = document.querySelector('#seek'); s.value = 17; s.dispatchEvent(new Event('change', { bubbles: true })); }); await reader.waitForTimeout(2500);
    out.offlineReader = await reader.evaluate(() => ({ title: document.title, page: document.querySelector('#pageName')?.textContent, canvas: document.querySelector('#sheet')?.width, loadingHidden: document.querySelector('#loading')?.classList.contains('hidden'), zones: document.querySelectorAll('.zone').length }));
    out.offlineReader.pass = out.offlineReader.canvas > 0 && out.offlineReader.loadingHidden;
    await ctx.close();
  } catch (e) { out.errors.push('fatal:' + (e.stack || e)); }
  finally { server?.kill(); fs.rmSync(profile, { recursive: true, force: true }); }
  fs.writeFileSync(path.join(__dirname, 'results-v2-offline.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, (k, v) => (k === 'packs' ? undefined : v), 1));
  if (out.errors.length || !out.offlineCamera?.pass || !out.offlineReader?.pass) process.exitCode = 1;
})();
