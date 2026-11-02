// Camera V2 UI: frames -> vision worker -> decision -> AudioController. Offline packs management.
import { FrameSource, AdaptiveRate } from './v2/frame-source.mjs';
import { AudioController } from './v2/audio-controller.mjs';
import { KIND_LABEL_AR } from './v2/content-audio.mjs';
import { loadPackIndex, packStatus, downloadPack, verifyPack, removePack, storageInfo, offlineReadiness, formatBytes } from './v2/offline-packs.mjs';

const $ = id => document.getElementById(id);
const APP_ROOT = new URL('../', import.meta.url);
const params = new URLSearchParams(location.search);
const ENGINE = params.get('engine') === 'v1' ? 'v1' : 'v2';
const stats = window.__v2 = { engine: ENGINE, longTasks: 0, longTaskMs: 0, results: 0, accepted: [], audio: [], procMs: [], pipelineMs: [], errors: [], ready: null };
const src = new FrameSource($('video')), rate = new AdaptiveRate();
const audio = new AudioController({ resolveUrl: c => new URL(c, APP_ROOT).href, onEvent: onAudio });
const fullPagePlayer = new Audio(); fullPagePlayer.preload = 'none';
let pageAudioClip = null, currentPage = null;
function showPageAudio(pageId, clip) {
  if (currentPage === pageId && pageAudioClip === clip) return;
  fullPagePlayer.pause(); fullPagePlayer.removeAttribute('src');
  currentPage = pageId; pageAudioClip = clip || null;
  $('pageAudio').disabled = !pageAudioClip; $('pageAudio').textContent = '▶ سماع الصفحة كاملة';
}
fullPagePlayer.onended = () => { $('pageAudio').textContent = '▶ سماع الصفحة كاملة'; };
fullPagePlayer.onerror = () => { $('pageAudio').textContent = '▶ سماع الصفحة كاملة'; setStatus('noaudio', 'تعذر تحميل تسجيل الصفحة'); };
let worker = null, active = false, inflight = false, frameId = 0, sent = new Map(), diag = false, held = null, packIndex = null;

const STATUS = {
  scanning: ['جارٍ الفحص…', ''], page: ['أشر إلى حرف أو كلمة', ''], uncertain: ['غير مؤكد', 'warn'], ok: ['تم التعرف', 'ok'], speaking: ['يُنطق الآن', 'ok'],
  noaudio: ['الصوت غير متوفر', 'warn'], weak: ['الصورة ضعيفة — حسّن الإضاءة أو ثبّت الهاتف', 'warn'], loading: ['تجهيز المحرك…', ''], off: ['لم يبدأ الفحص', ''],
};
const UNCERTAIN = new Set(['ambiguous-neighbours', 'pointer-type-uncertain', 'pointer-too-short', 'no-clear-tip', 'local-evidence-mismatch', 'target-occluded', 'ambiguous-page', 'stabilizing', 'tip-out-of-frame', 'no-text-at-tip']);
function setStatus(key, extra = '') { const [t, cls] = STATUS[key]; $('status').textContent = t + (extra ? ` — ${extra}` : ''); $('status').className = 'chip ' + cls; }

function onAudio(e) {
  if (e.type === 'started') { $('speaking').classList.add('on'); setStatus('speaking'); stats.audio.push({ clip: e.clip, latencyMs: e.latencyMs, fromCache: e.fromCache }); }
  if (e.type === 'ended') $('speaking').classList.remove('on');
  if (e.type === 'missing-file') { $('speaking').classList.remove('on'); setStatus('noaudio', 'ملف التسجيل غير موجود'); stats.audio.push({ clip: e.clip, missing: true }); }
}

function draw(r, w, h) {
  const c = $('overlay'); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d'); ctx.clearRect(0, 0, w, h); if (!r) return;
  const poly = (pts, color, lw, fill) => { if (!pts?.every(Boolean)) return; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke(); };
  const o = r.overlay || {};
  if (diag) {
    if (o.mask) { const { w: mw, h: mh, mask, work } = o.mask, img = ctx.createImageData(mw, mh); for (let k = 0; k < mask.length; k++) if (mask[k]) img.data.set([255, 77, 109, 100], k * 4); const t = new OffscreenCanvas(mw, mh); t.getContext('2d').putImageData(img, 0, 0); ctx.drawImage(t, 0, 0, mw * work, mh * work); }
    poly(o.outline, '#38e5a5', 2); (o.candidates || []).forEach(cd => poly(cd.corners, '#5aa9ff', 1)); poly(o.candidate, '#ffd038', 2);
  }
  if (held?.corners) poly(held.corners, '#eecd81', 4, '#eecd8155');       // only the accepted word is highlighted
  if (r.tip?.frame) { ctx.fillStyle = r.pointerType === 'pen' ? '#ffd038' : '#ff9f43'; ctx.strokeStyle = '#000a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.tip.frame.x, r.tip.frame.y, 6, 0, 7); ctx.fill(); ctx.stroke(); }
}

function handle(r, meta) {
  stats.results++;
  if (!r) return;
  if (r.accepted) {
    held = { id: r.targetId, corners: r.overlay.accepted };
    const kind = KIND_LABEL_AR[r.kind] || 'موضع', who = r.pointerType === 'pen' ? 'قلم' : 'إصبع';
    $('word').textContent = r.targetText; $('meta').textContent = `الصفحة ${r.pageId} • ${kind} • ${who}` + (r.spokenText ? ` • يُنطق: ${r.spokenText}` : '');
    stats.accepted.push({ id: r.targetId, page: r.pageId, play: r.play, at: meta.at, frameToResultMs: performance.now() - meta.at });
    if (r.play) { setStatus('ok'); if ($('sound').getAttribute('aria-pressed') === 'true') { fullPagePlayer.pause(); $('pageAudio').textContent = '▶ سماع الصفحة كاملة'; audio.play(r.audio.clip, { key: r.targetId, requestedAt: performance.now() }); } }
    else setStatus('noaudio');
  } else {
    const reason = r.rejectionReason || '';
    if (['already-pointing', 'cooldown'].includes(reason)) { /* keep showing the held word */ }
    else {
      if (!UNCERTAIN.has(reason)) { held = null; if (!r.pageId) { $('word').textContent = ''; $('meta').textContent = '—'; } }
      if (reason.startsWith('weak-camera')) setStatus('weak');
      else if (!r.pageId) setStatus('scanning');
      else if (UNCERTAIN.has(reason)) setStatus('uncertain');
      else { setStatus('page', `الصفحة ${r.pageId}`); if (!held) { $('word').textContent = ''; $('meta').textContent = `الصفحة ${r.pageId}`; } }
    }
  }
  $('hint').textContent = r.pageId ? `الصفحة ${r.pageId}` : 'وجّه الكاميرا إلى صفحة من الكتاب';
  if (diag) {
    const p = q => { const s = [...stats.procMs].sort((a, b) => a - b); return s.length ? s[Math.floor(q * (s.length - 1))].toFixed(0) : '-'; };
    const a = stats.audio.filter(x => x.latencyMs != null).map(x => x.latencyMs).sort((x, y) => x - y);
    $('diag').textContent = JSON.stringify({ engine: ENGINE, width: rate.width, procMs: { p50: p(0.5), p95: p(0.95) }, audioStartMs: a.length ? { p50: a[a.length >> 1].toFixed(0), n: a.length } : null, reason: r.rejectionReason, page: r.pageId, pointer: r.pointerType, tip: r.tip?.page, candidate: r.candidateId, confidence: r.confidence, quality: r.quality, timings: r.timings, evidence: r.sourceEvidence, content: r.content }, null, 1);
  }
}

async function pump() {
  if (!active || inflight || !src.ready) { if (active) requestAnimationFrame(pump); return; }
  inflight = true;
  try {
    const f = await src.grab(rate.width), id = ++frameId, at = performance.now(); sent.set(id, { at, w: f.width, h: f.height });
    worker.postMessage({ type: 'frame', id, at, width: f.width, height: f.height, buffer: f.buffer, bitmap: f.bitmap, debug: diag }, [f.buffer || f.bitmap]);
  } catch (e) { inflight = false; stats.errors.push(String(e)); requestAnimationFrame(pump); }
}

function startWorker() {
  return new Promise((resolve, reject) => {
    worker = new Worker(new URL('./v2/vision-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'ready') { stats.ready = m; resolve(m); }
      else if (m.type === 'progress') setStatus('loading', `${m.done}/${m.total}`);
      else if (m.type === 'page') { showPageAudio(m.pageId, m.fullAudio); audio.preload(m.clips); }
      else if (m.type === 'error') { stats.errors.push(m.message); if (!stats.ready) reject(new Error(m.message)); else { inflight = false; requestAnimationFrame(pump); } }
      else if (m.type === 'result') {
        const meta = sent.get(m.id); sent.delete(m.id); inflight = false;
        rate.record(m.procMs); stats.procMs.push(m.procMs); if (stats.procMs.length > 300) stats.procMs.shift();
        if (meta) { stats.pipelineMs.push(performance.now() - meta.at); if (stats.pipelineMs.length > 300) stats.pipelineMs.shift(); }
        handle(m.result, meta || { at: performance.now() }); draw(m.result, meta?.w || 480, meta?.h || 360);
        setTimeout(() => requestAnimationFrame(pump), 0);
      }
    };
    worker.onerror = e => { stats.errors.push(e.message || 'worker error'); reject(new Error(e.message || 'worker error')); };
    worker.postMessage({ type: 'init', appRoot: APP_ROOT.href, engine: ENGINE });
  });
}

async function start() {
  if (active) return stop();
  $('start').disabled = true; setStatus('loading');
  try {
    await audio.unlock();                                 // inside the user gesture: allowed to play later
    const ready = worker ? Promise.resolve() : startWorker();
    await src.start(); $('switch').hidden = src.devices.length < 2;
    await ready;
    active = true; $('start').textContent = '⏹ إيقاف الكاميرا'; $('start').classList.add('on'); setStatus('scanning');
    requestAnimationFrame(pump);
  } catch (e) { setStatus('weak'); $('status').textContent = 'تعذر التشغيل: ' + e.message; stats.errors.push(String(e)); src.stop(); }
  finally { $('start').disabled = false; }
}
function stop() {
  active = false; src.stop(); audio.stop(); fullPagePlayer.pause(); showPageAudio(null, null); worker?.postMessage({ type: 'reset' }); held = null; draw(null, 1, 1);
  $('start').textContent = '📷 تشغيل الكاميرا'; $('start').classList.remove('on'); setStatus('off'); $('hint').textContent = 'الكاميرا متوقفة'; $('speaking').classList.remove('on');
}

// ---------------- offline packs ----------------
async function refreshOffline() {
  try {
    packIndex ??= await loadPackIndex(APP_ROOT);
    const r = await offlineReadiness(packIndex, APP_ROOT); stats.offline = r;
    const chip = $('offline');
    if (r.ready) { chip.textContent = navigator.onLine ? 'جاهز دون إنترنت ✓' : 'دون اتصال — يعمل محليًا ✓'; chip.className = 'chip ok'; }
    else { chip.textContent = navigator.onLine ? 'غير جاهز دون إنترنت' : 'دون اتصال — الحزم غير مكتملة'; chip.className = 'chip warn'; }
    const s = await storageInfo(); $('storage').textContent = s.quota ? `المتاح ${formatBytes(s.free)}` : '';
    await renderPacks();
  } catch (e) { $('offline').textContent = 'تعذر فحص الجاهزية'; $('offline').className = 'chip bad'; stats.errors.push(String(e)); }
}
async function renderPacks() {
  const main = packIndex.packs.filter(p => !p.id.startsWith('edition-')), eds = packIndex.packs.filter(p => p.id.startsWith('edition-'));
  for (const [list, packs] of [[$('packList'), main], [$('editionList'), eds]]) {
    list.innerHTML = '';
    for (const p of packs) {
      const st = await packStatus(p, APP_ROOT), row = document.createElement('div'); row.className = 'pack'; row.dataset.pack = p.id;
      const state = st.complete ? (st.verified ? '✓ مكتمل ومتحقق' : 'مكتمل — يحتاج تحققًا') : st.present ? `${st.present}/${st.total} ملفات` : 'غير منزّل';
      row.innerHTML = `<div><b></b><small></small></div><div class="btns"></div><progress max="1" value="0" hidden></progress>`;
      row.querySelector('b').textContent = p.titleAr + (p.required ? ' — مطلوب' : '');
      row.querySelector('small').textContent = `${formatBytes(p.bytes)} • ${p.files.length} ملف • ${state}`;
      const btns = row.querySelector('.btns'), btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; btns.append(b); };
      if (!st.complete) btn('تنزيل', () => doDownload(p, row));
      else { btn('تحقق', () => doVerify(p, row)); btn('حذف', async () => { await removePack(p); refreshOffline(); }); }
      list.append(row);
    }
  }
}
async function doDownload(p, row) {
  const bar = row.querySelector('progress'), small = row.querySelector('small'); bar.hidden = false; row.querySelectorAll('button').forEach(b => (b.disabled = true));
  try {
    const v = await downloadPack(p, APP_ROOT, { onProgress: ({ done, total }) => { bar.value = done / total; small.textContent = `${formatBytes(done)} / ${formatBytes(total)}`; } });
    small.textContent = v.ok ? 'اكتمل التنزيل' : `ناقص: ${v.bad.length} ملف`;
  } catch (e) {
    const s = await storageInfo();
    small.textContent = e.message === 'storage-full' ? `لا توجد مساحة كافية (المطلوب ${formatBytes(p.bytes)}، المتاح ${s.free != null ? formatBytes(s.free) : 'غير معروف'})` : e.message.startsWith('integrity') ? 'فشل التحقق من سلامة ملف — أعد المحاولة' : 'تعذر التنزيل — تحقق من الاتصال ثم أعد المحاولة';
    stats.errors.push(e.message);
  }
  refreshOffline();
}
async function doVerify(p, row) { const small = row.querySelector('small'); small.textContent = 'جارٍ التحقق من سلامة الملفات…'; const v = await verifyPack(p, APP_ROOT, { deep: true }); small.textContent = v.ok ? `✓ سليم (${v.checked} ملف)` : `تالف/ناقص: ${v.bad.length}`; refreshOffline(); }

try { new PerformanceObserver(l => { for (const e of l.getEntries()) { stats.longTasks++; stats.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: true }); } catch {}
$('start').onclick = start;
$('pageAudio').onclick = async () => {
  if (!pageAudioClip) return;
  if (!fullPagePlayer.paused) { fullPagePlayer.pause(); $('pageAudio').textContent = '▶ سماع الصفحة كاملة'; return; }
  audio.stop();
  fullPagePlayer.src = new URL(pageAudioClip, APP_ROOT).href;
  try { await fullPagePlayer.play(); $('pageAudio').textContent = '⏸ إيقاف تسجيل الصفحة'; }
  catch { setStatus('noaudio', 'تعذر تشغيل التسجيل الكامل'); }
};
$('sound').onclick = () => { const on = $('sound').getAttribute('aria-pressed') !== 'true'; $('sound').setAttribute('aria-pressed', String(on)); $('sound').textContent = on ? '🔊 الصوت' : '🔇 الصوت متوقف'; audio.setEnabled(on); };
$('switch').onclick = async () => { await src.switchCamera(); worker?.postMessage({ type: 'reset' }); };
$('diagBtn').onclick = () => { diag = !diag; $('diagBtn').setAttribute('aria-pressed', String(diag)); $('diagBox').hidden = !diag; $('diagBox').open = diag; };
addEventListener('online', refreshOffline); addEventListener('offline', refreshOffline);
if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: APP_ROOT.pathname }).then(() => navigator.serviceWorker.ready).then(refreshOffline).catch(e => { stats.errors.push('sw:' + e.message); refreshOffline(); });
else refreshOffline();
