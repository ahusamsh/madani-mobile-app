// Runs the simulated benchmark (and a camera-trial smoke test) in headless Chromium via Playwright.
// Usage: node vision/bench/run-bench.cjs [--pages=17,18,19,20,21] [--zones=3]
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];

(async () => {
  const { chromium } = require('playwright');
  const server = spawn(process.execPath, [path.join(root, 'scripts/serve.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { server.stdout.on('data', d => String(d).includes('MADANI_SERVER') && res()); server.on('exit', c => rej(Error('server exited ' + c))); });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    // 1) camera trial smoke test with Chromium's default fake camera (no book page): must not speak
    const ctx = await browser.newContext({ permissions: ['camera'] }), trial = await ctx.newPage();
    trial.on('pageerror', e => errors.push('trial: ' + e.message));
    await trial.addInitScript(() => { window.__played = []; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (this instanceof HTMLAudioElement) window.__played.push(this.src); return play.call(this).catch(() => {}); }; });
    await trial.goto('http://127.0.0.1:8765/vision/camera-trial.html');
    await trial.click('#start');
    await trial.waitForFunction(() => /الفهرس جاهز|فهرسة الصفحات: [1-9]/.test(document.querySelector('#progress').textContent), null, { timeout: 120000 });
    await trial.waitForTimeout(2500);
    const smoke = await trial.evaluate(() => ({ result: document.querySelector('#result').textContent, state: document.querySelector('#state').textContent, progress: document.querySelector('#progress').textContent, played: window.__played }));
    await ctx.close();
    // 1b) camera trial end-to-end with a SIMULATED camera video of page 17 and a pen on one letter
    let e2e = null;
    { const gen = await browser.newPage(); await gen.goto('http://127.0.0.1:8765/vision/bench/bench.html?noRun=1');
      const zone = arg('e2eZone') || 'p17-w5', fake = await gen.evaluate(z => window.__makeFakeCamera(17, z), zone); await gen.close();
      const y4m = path.join(require('node:os').tmpdir(), 'madani-fake-camera.y4m'); fs.writeFileSync(y4m, Buffer.from(fake.b64, 'base64'));
      const b2 = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required'] });
      try {
        const c2 = await b2.newContext({ permissions: ['camera'] }), p2 = await c2.newPage(); p2.on('pageerror', e => errors.push('trial-e2e: ' + e.message));
        await p2.addInitScript(() => { window.__played = []; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (this instanceof HTMLAudioElement) window.__played.push(this.src); return play.call(this).catch(() => {}); }; });
        await p2.goto('http://127.0.0.1:8765/vision/camera-trial.html'); await p2.click('#start');
        await p2.waitForFunction(() => window.__played.length > 0, null, { timeout: 180000 }).catch(() => {});
        e2e = await p2.evaluate(() => ({ played: window.__played, result: document.querySelector('#result').textContent, state: document.querySelector('#state').textContent }));
        e2e.zone = zone; e2e.expectedClip = fake.expectedClip; e2e.text = fake.text;
        e2e.pass = e2e.played.length > 0 && e2e.played.every(u => u.endsWith(String(fake.expectedClip).replace(/^\.\//, '')));
        if (!e2e.pass) errors.push('trial-e2e: expected ' + fake.expectedClip + ' got ' + JSON.stringify(e2e.played));
      } finally { await b2.close(); fs.rmSync(y4m, { force: true }); }
    }
    // 2) reader regression: production page still loads unchanged
    const app = await browser.newPage(); app.on('pageerror', e => errors.push('app: ' + e.message));
    await app.goto('http://127.0.0.1:8765/'); await app.waitForTimeout(1500);
    const reader = await app.evaluate(() => ({ title: document.title, editions: document.querySelectorAll('#edition option').length, status: document.querySelector('#status')?.textContent }));
    await app.close();
    // 3) simulated benchmark on the real page images
    const page = await browser.newPage(); page.on('pageerror', e => errors.push('bench: ' + e.message));
    const q = new URLSearchParams({ ...(arg('pages') ? { pages: arg('pages') } : {}), ...(arg('zones') ? { zones: arg('zones') } : {}) });
    await page.goto('http://127.0.0.1:8765/vision/bench/bench.html?' + q);
    await page.waitForFunction(() => window.__bench, null, { timeout: 1800000 });
    const bench = await page.evaluate(() => window.__bench);
    const out = { generatedAt: new Date().toISOString(), cameraTrialSmoke: smoke, cameraTrialEndToEnd: e2e, readerRegression: reader, pageErrors: errors, ...bench };
    fs.writeFileSync(path.join(__dirname, 'results-simulated.json'), JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ cameraTrialSmoke: smoke, cameraTrialEndToEnd: e2e, readerRegression: reader, pageErrors: errors, summary: bench.summary, error: bench.error }, null, 2));
    if (bench.error || errors.length || (smoke.played || []).length) process.exitCode = 1;
  } finally { await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
