// Opt-in camera trial: live page identification, finger/pen tip, word/letter, original audio.
// All processing is local (vision/engine/*); no CDN models, no synthetic speech.
import { VisionEngine } from './engine/engine.mjs';
import { referencePages, referenceFeatures, loadGray, openFeatureCache } from './engine/browser-refs.mjs';

const $ = id => document.getElementById(id);
const APP_ROOT = new URL('../', import.meta.url);
const FRAME_W = 480;
const REASONS = {
  'page-not-identified': 'وجّه الكاميرا إلى صفحة من الكتاب…', 'insufficient-page-evidence': 'لا يكفي ما يظهر للتعرف على الصفحة', 'ambiguous-page': 'الصفحة غير مؤكدة (تشابه بين صفحتين)',
  'confirming-page': 'جارٍ التأكد من الصفحة…', 'page-tracking-dropout': 'فُقد تتبع الصفحة لحظيًا', 'loading-reference-page': 'تحميل صورة الصفحة المرجعية…',
  'weak-camera-dark': 'الإضاءة ضعيفة جدًا', 'weak-camera-overexposed': 'الصورة شديدة السطوع', 'weak-camera-low-contrast': 'الصورة باهتة', 'weak-camera-blur': 'الصورة مهتزة أو غير واضحة',
  'no-pointer-evidence': 'لا يوجد إصبع أو قلم', 'occluder-not-entering-from-outside': 'لا يوجد إصبع أو قلم', 'tip-out-of-frame': 'طرف المؤشر خارج الإطار', 'no-clear-tip': 'طرف المؤشر غير واضح',
  'pointer-type-uncertain': 'المؤشر غير مؤكد (إصبع أم قلم؟)', 'pointer-too-short': 'المؤشر غير واضح', 'page-occluded-or-misregistered': 'الصفحة مغطاة أكثر من اللازم', 'page-not-in-view': 'الصفحة خارج الإطار',
  'tip-outside-page': 'الطرف خارج الصفحة', 'no-text-at-tip': 'لا توجد كلمة تحت الطرف', 'ambiguous-neighbours': 'الطرف بين كلمتين — غير مؤكد', 'target-occluded': 'الكلمة مغطاة', 'local-evidence-mismatch': 'ما تحت الطرف لا يطابق الصفحة',
  'page-has-no-zone-map': 'هذه الصفحة بلا خريطة مواضع', 'stabilizing': 'ثبّت المؤشر…', 'already-pointing': '', 'cooldown': '', 'no-reliable-pointer': 'لا يوجد إصبع أو قلم', 'no-reliable-page': 'الصفحة غير مؤكدة',
};

let engine, stream, active = false, audio, lastShown = null, latencies = [];
const canvas = document.createElement('canvas'), ctx2 = canvas.getContext('2d', { willReadFrequently: true });

async function buildIndex(library) {
  const db = await openFeatureCache(), refs = referencePages(library, APP_ROOT), urls = new Map(refs.map(r => [r.pageId, r.url]));
  engine = new VisionEngine({ library, loadGray: id => loadGray(urls.get(id)), keepPages: 4 });
  let n = 0, cached = 0;
  for (const ref of refs) {
    if (!active && n > 0) break;
    const r = await referenceFeatures(ref, db); if (r.cached) cached++;
    engine.addReferencePage(ref.pageId, null, r.features, r.size, r.thumb); n++;
    $('progress').textContent = `فهرسة الصفحات: ${n} / ${refs.length} (من الذاكرة: ${cached}) — يمكنك البدء بالصفحات 17–21 ذات الأصوات المرتبطة`;
    await new Promise(r => setTimeout(r, 0));
  }
  $('progress').textContent = `الفهرس جاهز: ${n} صفحة. تعمل المعالجة على الجهاز فقط.`;
}

function drawPoly(ctx, pts, color, width) { if (!pts?.every(Boolean)) return; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); }

function overlay(r, w, h) {
  const c = $('overlay'); c.width = w; c.height = h; const ctx = c.getContext('2d');
  const d = r.debug || {};
  if ($('showDebug').checked && d.pointer?.mask) {
    const { w: mw, h: mh, mask, work } = d.pointer, img = ctx.createImageData(mw, mh);
    for (let k = 0; k < mask.length; k++) if (mask[k]) img.data.set([255, 77, 109, 110], k * 4);
    const tmp = Object.assign(document.createElement('canvas'), { width: mw, height: mh }); tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, mw * work, mh * work);
  }
  drawPoly(ctx, d.outline, '#38e5a5', 2);
  for (const c2 of d.candidates || []) drawPoly(ctx, c2.corners.map(p => p && { x: p.x, y: p.y }), '#5aa9ff', 1);
  if (d.accepted) drawPoly(ctx, d.accepted.corners, '#38e5a5', 4);
  if (r.tip?.frame) { ctx.strokeStyle = '#ffd038'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(r.tip.frame.x, r.tip.frame.y, 7, 0, 2 * Math.PI); ctx.stroke(); }
}

function show(r) {
  if (r.accepted) {
    const who = r.pointerType === 'pen' ? 'قلم' : 'إصبع', kind = r.kind === 'letter' ? 'حرف' : 'كلمة';
    $('result').innerHTML = '';
    const t = document.createElement('span'); t.className = 't'; t.textContent = r.targetText;
    $('result').append(`الصفحة ${r.pageId} • ${kind} • ${who}: `, t, r.play ? '' : ' — الصوت غير متوفر لهذا الموضع');
    lastShown = r;
    if (r.play && $('sound').checked) { audio.pause(); audio.src = new URL(r.audio.clip, APP_ROOT).href; audio.currentTime = 0; audio.play().catch(e => console.warn('audio', e)); }
  } else if (!lastShown || r.rejectionReason !== 'already-pointing') {
    const msg = REASONS[r.rejectionReason] ?? r.rejectionReason;
    if (msg) $('state').textContent = (r.pageId ? `الصفحة ${r.pageId} — ` : '') + msg;
    if (!['already-pointing', 'cooldown', 'stabilizing'].includes(r.rejectionReason)) lastShown = null;
  }
  if ($('showDebug').checked) {
    const { debug, quality, ...rest } = r, lat = [...latencies].sort((a, b) => a - b);
    $('debug').textContent = JSON.stringify({ ...rest, quality: { mean: quality.mean | 0, std: quality.std | 0, sharpness: quality.sharpness | 0, weak: quality.weak }, features: debug?.features, latencyMs: { p50: lat[lat.length >> 1] | 0, p95: lat[Math.floor(lat.length * 0.95)] | 0, n: lat.length } }, null, 2);
  }
}

async function loop() {
  if (!active) return;
  const v = $('video');
  if (v.readyState >= 2 && engine?.index.size) {
    const w = FRAME_W, h = Math.round((v.videoHeight * w) / v.videoWidth);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx2.drawImage(v, 0, 0, w, h);
    const t = performance.now(), r = engine.processFrame({ rgba: ctx2.getImageData(0, 0, w, h).data, width: w, height: h, at: t });
    latencies.push(performance.now() - t); if (latencies.length > 200) latencies.shift();
    show(r); overlay(r, w, h);
  }
  setTimeout(() => requestAnimationFrame(loop), 15);
}

async function start() {
  $('start').disabled = true; $('result').textContent = 'جارٍ التحضير…';
  try {
    audio = new Audio(); audio.preload = 'auto'; // created inside the click handler so playback is allowed
    const library = await (await fetch(new URL('data/audio-library.json', APP_ROOT))).json();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
    $('video').srcObject = stream; await $('video').play();
    active = true; $('stop').disabled = false; $('result').textContent = 'وجّه الكاميرا إلى صفحة…';
    buildIndex(library).catch(e => { $('progress').textContent = 'تعذرت الفهرسة: ' + e.message; });
    requestAnimationFrame(loop);
  } catch (e) { $('result').textContent = 'تعذر تشغيل الكاميرا: ' + e.message; stop(); }
}
function stop() {
  active = false; stream?.getTracks().forEach(t => t.stop()); stream = null; $('video').srcObject = null; engine?.reset(); audio?.pause();
  $('start').disabled = false; $('stop').disabled = true; $('state').textContent = 'متوقف';
}
$('start').onclick = start; $('stop').onclick = stop;
$('showDebug').onchange = () => { $('debug').hidden = !$('showDebug').checked; };
