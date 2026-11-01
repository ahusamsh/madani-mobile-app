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
    // 1) camera trial smoke test: page loads, no exceptions, starts with the fake camera, builds index, no output without a book page
    const ctx = await browser.newContext({ permissions: ['camera'] }), trial = await ctx.newPage();
    trial.on('pageerror', e => errors.push('trial: ' + e.message));
    await trial.goto('http://127.0.0.1:8765/vision/camera-trial.html');
    await trial.click('#start');
    await trial.waitForFunction(() => /الفهرس جاهز|فهرسة الصفحات: [1-9]/.test(document.querySelector('#progress').textContent), null, { timeout: 120000 });
    await trial.waitForTimeout(2500);
    const smoke = await trial.evaluate(() => ({ result: document.querySelector('#result').textContent, state: document.querySelector('#state').textContent, progress: document.querySelector('#progress').textContent }));
    await ctx.close();
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
    const out = { generatedAt: new Date().toISOString(), cameraTrialSmoke: smoke, readerRegression: reader, pageErrors: errors, ...bench };
    fs.writeFileSync(path.join(__dirname, 'results-simulated.json'), JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ cameraTrialSmoke: smoke, readerRegression: reader, pageErrors: errors, summary: bench.summary, error: bench.error }, null, 2));
    if (bench.error || errors.length) process.exitCode = 1;
  } finally { await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
