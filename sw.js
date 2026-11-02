// Madani PWA service worker (v4).
// - "madani-shell-<VERSION>": app shell + camera engine code, replaced on every release
// - "madani-pack-<id>-<version>": offline packs downloaded from the app (data/offline-packs.json);
//    NEVER deleted on update (the pack manager replaces a pack only after its new version is complete)
// - "madani-runtime-<VERSION>": opportunistic cache of other same-origin GETs (small files only)
const VERSION = 'v7-word-audio-840';
const SHELL_CACHE = 'madani-shell-' + VERSION, RUNTIME_CACHE = 'madani-runtime-' + VERSION;
const ENGINE = ['image', 'features', 'page-matcher', 'pointer', 'target', 'engine', 'browser-refs', 'synth'].map(n => `./vision/engine/${n}.mjs`);
const V2 = ['engine-v2', 'audio-controller', 'content-audio', 'offline-packs', 'ref-index', 'vision-worker', 'frame-source'].map(n => `./vision/v2/${n}.mjs`);
const SHELL = [
  './', './index.html', './app.js', './style.css', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './vendor/pdf.mjs', './vendor/pdf.worker.mjs', './data/editions.json', './data/toc.json', './data/offline-packs.json', './data/audio-coverage.json', './data/audio-library.json',
  './vision/recognition-core.mjs', ...ENGINE, ...V2, './vision/camera-v2.html', './vision/camera-v2.mjs',
  './vision/camera-trial.html', './vision/camera-trial.mjs',
];
const CODE = /\.(html|m?js|css|webmanifest)$|\/$/;
const FRESH_DATA = new Set(['/data/audio-library.json', '/data/offline-packs.json', '/data/audio-coverage.json']);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    const results = await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) console.warn('shell precache incomplete:', failed); // readiness check in the app reports this
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const n of await caches.keys()) {
      const oldShell = (n.startsWith('madani-shell-') || n.startsWith('madani-runtime-')) && n !== SHELL_CACHE && n !== RUNTIME_CACHE;
      if (oldShell || n.startsWith('madani-mobile-')) await caches.delete(n); // legacy v1-v3 single cache
    }
    await self.clients.claim();
  })());
});

async function fromCacheWithRange(req, cached) {
  const range = req.headers.get('Range');
  if (!range || !cached) return cached;
  const buf = await cached.arrayBuffer(), m = /bytes=(\d*)-(\d*)/.exec(range), size = buf.byteLength;
  let start = m && m[1] !== '' ? +m[1] : 0, end = m && m[2] !== '' ? +m[2] : size - 1;
  if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, size - +m[2]); end = size - 1; }
  if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, size - 1);
  return new Response(buf.slice(start, end + 1), { status: 206, headers: { 'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const key = url.origin + url.pathname, cached = await caches.match(key);
    // The library and offline pack manifest change after each audio-alignment release.
    // Serve fresh metadata while online; prefer this version's shell cache when offline.
    // An old offline pack must not shadow the newly published word/audio mappings.
    if (FRESH_DATA.has(url.pathname)) {
      const shell = await caches.open(SHELL_CACHE);
      try {
        const net = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('metadata timeout')), 7000))
        ]);
        if (!net.ok) throw new Error('metadata unavailable');
        e.waitUntil(shell.put(key, net.clone()).catch(() => {}));
        return net;
      } catch (error) {
        const current = await shell.match(key);
        if (current) return current;
        if (cached) return cached;
        throw error;
      }
    }

    if (CODE.test(url.pathname) && !url.pathname.endsWith('.json')) {
      // code: network-first (fresh releases), cache fallback (offline), short timeout on flaky networks
      try {
        const net = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), cached ? 3000 : 15000))]);
        if (net.ok && SHELL.some(s => new URL(s, location.href).pathname === url.pathname)) (await caches.open(SHELL_CACHE)).put(key, net.clone());
        return net;
      } catch (err) { if (cached) return cached; throw err; }
    }
    if (cached) return fromCacheWithRange(req, cached);       // packs / media / data: cache-first
    const net = await fetch(req);
    const len = Number(net.headers.get('content-length') || 0);
    if (net.ok && net.status === 200 && !req.headers.has('Range') && (!url.pathname.endsWith('.pdf') || len < 25_000_000)) caches.open(RUNTIME_CACHE).then(c => c.put(key, net.clone())).catch(() => {}); // as v3: pages/books seen online stay usable
    return net;
  })());
});
