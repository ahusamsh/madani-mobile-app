// Baseline vs V2 on identical SIMULATED sequences in headless Chromium. Writes vision/bench/results-compare.json.
// Usage: NODE_PATH=$(npm root -g) node vision/bench/run-compare.cjs [--pages=17,18,19,20,21] [--zones=2]
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..'), arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
(async () => {
  const { chromium } = require('playwright');
  const server = spawn(process.execPath, [path.join(root, 'scripts/serve.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { server.stdout.on('data', d => String(d).includes('MADANI_SERVER') && res()); server.on('exit', c => rej(Error('server exited ' + c))); });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); page.on('pageerror', e => console.error(e));
    const q = new URLSearchParams({ pages: arg('pages') || '17,18,19,20,21', zones: arg('zones') || '2' });
    await page.goto('http://127.0.0.1:8765/vision/bench/compare.html?' + q);
    await page.waitForFunction(() => window.__compare, null, { timeout: 7000000 });
    const r = await page.evaluate(() => window.__compare);
    fs.writeFileSync(path.join(__dirname, 'results-compare.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...r }, null, 1));
    console.log(JSON.stringify({ error: r.error, v1: r.v1?.summary, v2: r.v2?.summary }, null, 1));
    if (r.error) process.exitCode = 1;
  } finally { await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
