// Generates data/offline-packs.json: downloadable offline packs with exact byte sizes and SHA-256 of
// every file, used by the in-app pack manager (download progress, integrity check, storage estimate).
// Usage: node scripts/build-offline-packs.cjs
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const lib = JSON.parse(fs.readFileSync(path.join(root, 'data/audio-library.json'), 'utf8'));
const editions = JSON.parse(fs.readFileSync(path.join(root, 'data/editions.json'), 'utf8'));
const rel = p => './' + p.replace(/^\.\//, '');
const fileEntry = p => { const abs = path.join(root, p.replace(/^\.\//, '')); const buf = fs.readFileSync(abs); return { url: rel(p), bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }; };
const list = dir => fs.readdirSync(path.join(root, dir)).filter(f => fs.statSync(path.join(root, dir, f)).isFile()).sort().map(f => `${dir}/${f}`);
const uniq = a => [...new Set(a.map(rel))];

const refImages = Object.values(lib.pages).filter(p => typeof p.image === 'string').map(p => p.image);
const clips = [...Object.values(lib.segments).map(s => s.clip), ...Object.values(lib.pages).flatMap(p => (p.boxes || []).map(b => b.clip))].filter(c => typeof c === 'string');
const pageAudio = [...list('library-audio'), ...Object.values(lib.pages).map(p => p.localAudio).filter(Boolean)];

const packs = [
  { id: 'camera-ar', titleAr: 'الكاميرا والنطق — العربية', required: true, description: 'Reference index, page images, zone maps and the original clip recordings needed by the offline camera.',
    files: uniq(['data/audio-library.json', 'vision/data/ref-index.bin', ...refImages, ...clips]) },
  { id: 'book-ar', titleAr: 'الكتاب العربي (PDF) للقراءة دون إنترنت', required: true, description: 'Arabic PDF, its page map and the PDF viewer resources.',
    files: uniq(['books/ar.pdf', 'data/edition-maps/ar.json', ...list('vendor/cmaps'), ...list('vendor/standard_fonts')]) },
  { id: 'page-audio-ar', titleAr: 'تسجيلات الصفحات الكاملة (اختياري)', required: false, description: 'Full-page original recordings used by the reader\'s page playback.',
    files: uniq(pageAudio) },
  ...Object.values(editions.locales).filter(l => l.code !== 'ar' && fs.existsSync(path.join(root, `books/${l.code}.pdf`))).map(l => ({
    id: `edition-${l.code}`, titleAr: `طبعة ${l.nameArabic}`, required: false, description: `${l.nameEnglish} edition PDF and page map (teaching audio stays Arabic).`,
    files: uniq([`books/${l.code}.pdf`, ...(fs.existsSync(path.join(root, `data/edition-maps/${l.code}.json`)) ? [`data/edition-maps/${l.code}.json`] : [])]) })),
];
const out = { schema: 1, generatedAt: new Date().toISOString(), packs: packs.map(p => { const files = p.files.map(fileEntry); const h = crypto.createHash('sha256'); files.forEach(f => h.update(f.url + f.sha256)); return { ...p, version: h.digest('hex').slice(0, 12), bytes: files.reduce((s, f) => s + f.bytes, 0), files }; }) };
fs.writeFileSync(path.join(root, 'data/offline-packs.json'), JSON.stringify(out, null, 1));
for (const p of out.packs) console.log(p.id.padEnd(16), String(p.files.length).padStart(4), 'files', (p.bytes / 1048576).toFixed(1).padStart(7), 'MB', p.version);
