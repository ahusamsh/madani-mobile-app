// Offline pack manager (browser). Packs are listed in data/offline-packs.json with exact sizes and SHA-256.
// Each pack lives in its own Cache Storage cache "madani-pack-<id>-<version>"; the service worker never deletes
// pack caches on app updates (only superseded versions of the same pack, after the new one is complete).
const PREFIX = 'madani-pack-';
const cacheName = p => `${PREFIX}${p.id}-${p.version}`;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function loadPackIndex(appRoot) {
  const r = await fetch(new URL('data/offline-packs.json', appRoot)); if (!r.ok) throw new Error('pack index unavailable');
  return r.json();
}
export function formatBytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(n / 1024))} ك.ب`; }

export async function storageInfo() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { usage: est.usage ?? null, quota: est.quota ?? null, free: est.quota != null ? est.quota - est.usage : null, persisted };
}
export async function requestPersistence() { try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; } }

/** Which files of a pack are present in its cache (fast presence check). */
export async function packStatus(pack, appRoot) {
  if (!('caches' in self)) return { id: pack.id, complete: false, present: 0, total: pack.files.length, bytesPresent: 0, reason: 'no-cache-api' };
  const c = await caches.open(cacheName(pack)); let present = 0, bytesPresent = 0;
  for (const f of pack.files) if (await c.match(new URL(f.url, appRoot).href)) { present++; bytesPresent += f.bytes; }
  const meta = readMeta()[pack.id];
  return { id: pack.id, complete: present === pack.files.length, present, total: pack.files.length, bytesPresent, verified: meta?.version === pack.version && meta?.verified === true, verifiedAt: meta?.at ?? null };
}

function readMeta() { try { return JSON.parse(localStorage.getItem('madani-packs') || '{}'); } catch { return {}; } }
function writeMeta(id, v) { try { const m = readMeta(); if (v) m[id] = v; else delete m[id]; localStorage.setItem('madani-packs', JSON.stringify(m)); } catch {} }

/**
 * Download missing files with byte progress and SHA-256 verification before caching.
 * onProgress({done, total, file}) — bytes. Throws Error('storage-full' | 'integrity:<url>' | 'network:<url>').
 */
export async function downloadPack(pack, appRoot, { onProgress = () => {}, concurrency = 4, signal } = {}) {
  const info = await storageInfo(), st = await packStatus(pack, appRoot), need = pack.bytes - st.bytesPresent;
  if (info.free != null && need > info.free * 0.9) throw new Error('storage-full');
  await requestPersistence();
  const c = await caches.open(cacheName(pack)); let done = st.bytesPresent; const total = pack.bytes;
  const queue = []; for (const f of pack.files) if (!(await c.match(new URL(f.url, appRoot).href))) queue.push(f);
  onProgress({ done, total });
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new Error('aborted');
      const f = queue.shift(), url = new URL(f.url, appRoot).href;
      let res; try { res = await fetch(url, { cache: 'no-store', signal }); } catch { throw new Error('network:' + f.url); }
      if (!res.ok || !res.body) throw new Error('network:' + f.url);
      const reader = res.body.getReader(), chunks = []; let got = 0;
      for (;;) { const { done: end, value } = await reader.read(); if (end) break; chunks.push(value); got += value.byteLength; done += value.byteLength; onProgress({ done, total, file: f.url }); }
      const buf = new Uint8Array(got); let o = 0; for (const ch of chunks) { buf.set(ch, o); o += ch.byteLength; }
      if (got !== f.bytes || hex(await crypto.subtle.digest('SHA-256', buf)) !== f.sha256) { done -= got; throw new Error('integrity:' + f.url); }
      try { await c.put(url, new Response(buf, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Content-Length': String(got), 'X-Madani-Pack': pack.id } })); }
      catch (e) { throw new Error(e?.name === 'QuotaExceededError' ? 'storage-full' : 'cache-write:' + f.url); }
    }
  };
  try { await Promise.all(Array.from({ length: concurrency }, worker)); }
  finally { writeMeta(pack.id, { version: pack.version, verified: false, at: Date.now() }); }
  const v = await verifyPack(pack, appRoot, { deep: false });
  if (v.ok) await removeOldVersions(pack);
  return v;
}

/** Integrity check. deep=true re-hashes every cached file against the manifest SHA-256. */
export async function verifyPack(pack, appRoot, { deep = true } = {}) {
  const c = await caches.open(cacheName(pack)), bad = [];
  for (const f of pack.files) {
    const r = await c.match(new URL(f.url, appRoot).href);
    if (!r) { bad.push({ url: f.url, problem: 'missing' }); continue; }
    if (deep) { const b = await r.arrayBuffer(); if (b.byteLength !== f.bytes || hex(await crypto.subtle.digest('SHA-256', b)) !== f.sha256) bad.push({ url: f.url, problem: 'hash' }); }
  }
  const ok = !bad.length; writeMeta(pack.id, { version: pack.version, verified: ok, deep, at: Date.now() });
  return { ok, bad, checked: pack.files.length, deep };
}

export async function removePack(pack) { for (const n of await caches.keys()) if (n.startsWith(`${PREFIX}${pack.id}-`)) await caches.delete(n); writeMeta(pack.id, null); }
async function removeOldVersions(pack) { for (const n of await caches.keys()) if (n.startsWith(`${PREFIX}${pack.id}-`) && n !== cacheName(pack)) await caches.delete(n); }

/** Offline-ready = service worker controlling the page + shell cached + every required pack complete and verified. */
export async function offlineReadiness(index, appRoot) {
  const sw = !!navigator.serviceWorker?.controller, shell = sw && (await caches.keys()).some(n => n.startsWith('madani-shell-'));
  const required = index.packs.filter(p => p.required), statuses = await Promise.all(required.map(p => packStatus(p, appRoot)));
  return { ready: sw && shell && statuses.every(s => s.complete && s.verified), serviceWorker: sw, shell, packs: statuses };
}
