// Baseline vs V2 on identical SIMULATED sequences in headless Chromium. Writes vision/bench/results-compare.json.
// Usage: node vision/bench/run-compare.cjs [--pages=17,18,19,20,21] [--zones=2]
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..'), arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
(async () => {
  const pw = require('./pw.cjs');
  const server = spawn(process.execPath, [path.join(root, 'scripts/serve.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { server.stdout.on('data', d => String(d).includes('MADANI_SERVER') && res()); server.on('exit', c => rej(Error('server exited ' + c))); });
  const browser = await pw.launch();
  try {
    const page = await browser.newPage(); page.on('pageerror', e => console.error(e));
    const q = new URLSearchParams({ pages: arg('pages') || '13,17,21,25,28,47', zones: arg('zones') || '2', engines: arg('engines') || 'v2,v3', ...(arg('truth') !== '0' ? { truth: '1' } : {}), ...(arg('source') ? { source: arg('source') } : {}) });
    await page.goto('http://127.0.0.1:8765/vision/bench/compare.html?' + q);
    await page.waitForFunction(() => window.__compare, null, { timeout: 7000000 });
    const r = await page.evaluate(() => window.__compare);
    fs.writeFileSync(path.join(__dirname, arg('out') || 'results-compare.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...r }, null, 1));
    console.log(JSON.stringify({ error: r.error, source: r.source, v1: r.v1?.summary, v2: r.v2?.summary, v3: r.v3?.summary }, null, 1));
    if (r.error) process.exitCode = 1;
  } finally { await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
