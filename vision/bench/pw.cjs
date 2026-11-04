// Playwright loader that works with either `playwright` (bundled Chromium) or `playwright-core` + installed Chrome.
function load() { for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch {} } throw new Error('install playwright or playwright-core'); }
const { chromium } = load();
async function launch(opts = {}) {
  try { return await chromium.launch({ headless: true, ...opts }); }
  catch (e) { return chromium.launch({ headless: true, channel: 'chrome', ...opts }); }
}
async function launchPersistent(dir, opts = {}) {
  try { return await chromium.launchPersistentContext(dir, { headless: true, ...opts }); }
  catch (e) { return chromium.launchPersistentContext(dir, { headless: true, channel: 'chrome', ...opts }); }
}
module.exports = { chromium, launch, launchPersistent };
