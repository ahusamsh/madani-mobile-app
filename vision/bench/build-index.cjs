// Builds vision/data/ref-index.bin in headless Chromium (same decode + feature code as the camera page).
// Usage: NODE_PATH=$(npm root -g) node vision/bench/build-index.cjs
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
(async () => {
  const { chromium } = require('playwright');
  const server = spawn(process.execPath, [path.join(root, 'scripts/serve.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { server.stdout.on('data', d => String(d).includes('MADANI_SERVER') && res()); server.on('exit', c => rej(Error('server exited ' + c))); });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); page.on('pageerror', e => { console.error(e); process.exitCode = 1; });
    await page.goto('http://127.0.0.1:8765/vision/bench/build-index.html');
    await page.waitForFunction(() => window.__index, null, { timeout: 600000 });
    const r = await page.evaluate(() => window.__index), out = path.join(root, 'vision/data/ref-index.bin');
    fs.writeFileSync(out, Buffer.from(r.b64, 'base64')); console.log('wrote', out, r.pages, 'pages', fs.statSync(out).size, 'bytes');
  } finally { await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
