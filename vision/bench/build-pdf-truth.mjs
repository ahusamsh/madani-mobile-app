// Independent ground truth for target-accuracy tests: glyph/word positions from the PDF TEXT LAYER of
// books/ar.pdf (not from the zone map, not from image analysis). A zone gets a truth point only when a PDF
// text item with the same normalised text lies near it. Usage: node vision/bench/build-pdf-truth.mjs 13,17,21,...
import * as pdfjs from '../../vendor/pdf.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const lib = JSON.parse(readFileSync(root + 'data/audio-library.json', 'utf8'));
export const norm = s => [...String(s ?? '').normalize('NFC').replace(/[ـ\s]/gu, '')].sort().join(''); // order-free: PDF extraction puts marks before/after letters
const pages = (process.argv[2] || '13,17,21,25,47,60,80,100').split(',').map(Number);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(root + 'books/ar.pdf')), cMapUrl: root + 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: root + 'vendor/standard_fonts/', disableFontFace: true, isEvalSupported: false }).promise;
const out = { source: 'books/ar.pdf text layer (pdf.js getTextContent)', pages: {} };
for (const pageId of pages) {
  const pg = await doc.getPage(pageId), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
  // merge stand-alone harakat items into the base-letter item drawn at the same x (pdf splits "تَ" into "ت" + "َ")
  const items = tc.items.filter(it => it.str.trim()).map(it => { const [, , c, d, e, f] = it.transform, h = Math.hypot(c, d); return { str: it.str.trim(), x0: e / vp.width, x1: (e + it.width) / vp.width, base: (vp.height - f) / vp.height, h: h / vp.height }; });
  // lines -> words: split on spaces, distribute the item's width proportionally to word length (RTL: first word on the right)
  const words = items.flatMap(i => { const parts = i.str.split(/\s+/u).filter(Boolean); if (parts.length < 2) return [i]; const tot = parts.reduce((s, w) => s + [...w].length, 0) + parts.length - 1; let acc = 0; return parts.map(w => { const n = [...w].length, x1 = i.x1 - ((i.x1 - i.x0) * acc) / tot, x0 = x1 - ((i.x1 - i.x0) * n) / tot; acc += n + 1; return { ...i, str: w, x0, x1, split: true }; }); });
  const letters = words.filter(i => /[ء-ي]/u.test(i.str)), marks = words.filter(i => !/[ء-ي]/u.test(i.str) && /[ً-ْٰ]/u.test(i.str));
  for (const m of marks) { const host = letters.filter(l => m.x0 >= l.x0 - 0.012 && m.x0 <= l.x1 + 0.012 && Math.abs(l.base - m.base) < 0.03).sort((a, b) => Math.abs(a.base - m.base) - Math.abs(b.base - m.base))[0]; if (host) host.str += m.str; }
  const truth = [];
  for (const z of lib.pages[pageId]?.zones || []) {
    const [zx, zy, zw, zh] = z.box, key = norm(z.text);
    const cands = letters.filter(l => norm(l.str) === key).map(l => ({ l, d: Math.hypot((l.x0 + l.x1) / 2 - (zx + zw / 2), (l.base - l.h * 0.35) - (zy + zh / 2)) })).sort((a, b) => a.d - b.d);
    if (!cands.length || cands[0].d > 0.06 || (cands[1] && cands[1].d < 0.06 && cands[1].d - cands[0].d < 0.01)) continue; // no or ambiguous match: no truth
    if (cands[0].l.x1 - cands[0].l.x0 < 0.004) continue; // zero-width PDF fragments have no usable position
    const l = cands[0].l; // glyph body: from ~0.75*h above the baseline to ~0.2*h below it
    truth.push({ zoneId: z.id, text: z.text, box: [l.x0, l.base - l.h * 0.75, l.x1 - l.x0, l.h * 0.95], zoneOffset: +cands[0].d.toFixed(4) });
  }
  out.pages[pageId] = { zones: (lib.pages[pageId]?.zones || []).length, withTruth: truth.length, truth };
  console.log(pageId, 'zones', out.pages[pageId].zones, 'truth', truth.length);
}
writeFileSync(root + 'vision/bench/pdf-truth.json', JSON.stringify(out));
