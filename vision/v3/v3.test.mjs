// V3 tests on REAL page pixels (fixtures: reference images of pages 13 and 18 at 640 px) and the REAL library.
// Ground truth for glyph positions comes from the PDF text layer (vision/bench/pdf-truth.json), not from zones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { zoneTokens } from '../engine/target.mjs';
import { chooseTarget } from '../recognition-core.mjs';
import { inkSnappedTokens, inkUnits, components, inkMask } from './ink-layout.mjs';
import { selectInkTarget } from './target-v3.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const library = JSON.parse(readFileSync(root + 'data/audio-library.json', 'utf8'));
const truth = JSON.parse(readFileSync(root + 'vision/bench/pdf-truth.json', 'utf8')).pages;
const page = n => { const m = JSON.parse(readFileSync(new URL(`./fixtures/page-${String(n).padStart(3, '0')}-640.json`, import.meta.url))); return { w: m.w, h: m.h, d: new Uint8ClampedArray(gunzipSync(readFileSync(new URL(`./fixtures/page-${String(n).padStart(3, '0')}-640.gray.gz`, import.meta.url)))) }; };
const tipsFor = (tr, g) => [0.3, 0.5, 0.7].flatMap(fx => [0.5, 0.85].map(fy => ({ x: (tr.box[0] + tr.box[2] * fx) * g.w, y: (tr.box[1] + tr.box[3] * fy) * g.h })));

test('root cause p13-w19 (تَ): the heuristic zone overlaps بَ above; ink snapping moves it onto the printed تَ', () => {
  const g = page(13), base = zoneTokens(library, 13, g.w, g.h), { tokens } = inkSnappedTokens(g, base);
  const z = base.find(t => t.id === 'p13-w19'), s = tokens.find(t => t.id === 'p13-w19'), tr = truth[13].truth.find(t => t.zoneId === 'p13-w19');
  const ty0 = tr.box[1] * g.h, ty1 = (tr.box[1] + tr.box[3]) * g.h;
  assert.ok(z.box.y < ty0 - 15, 'zone box starts well above the printed glyph (inside بَ)');
  assert.equal(s.snap, 'ink');
  assert.ok(s.box.y >= ty0 - 4 && s.box.y + s.box.height <= ty1 + 6, `snapped ${JSON.stringify(s.box)} vs truth y ${ty0.toFixed(0)}-${ty1.toFixed(0)}`);
  for (const tip of tipsFor(tr, g)) assert.equal(selectInkTarget(tip, tokens).target?.id, 'p13-w19');
});

test('class fix: on page 13 every PDF-truth glyph point selects its own zone (V2: many uncertain); never a neighbour', () => {
  const g = page(13), base = zoneTokens(library, 13, g.w, g.h), { tokens } = inkSnappedTokens(g, base);
  let v2 = { ok: 0, wrong: 0 }, v3 = { ok: 0, wrong: 0 };
  for (const tr of truth[13].truth) for (const tip of tipsFor(tr, g)) {
    const a = chooseTarget(tip, base).target, b = selectInkTarget(tip, tokens).target;
    if (a) a.id === tr.zoneId ? v2.ok++ : v2.wrong++; if (b) b.id === tr.zoneId ? v3.ok++ : v3.wrong++;
  }
  assert.equal(v3.wrong, 0); assert.ok(v3.ok > v2.ok + 50, JSON.stringify({ v2, v3 }));
});

test('thin glyphs (isolated ا on page 18) are selectable just below the ink, where a fingertip touches', () => {
  const g = page(18), { tokens } = inkSnappedTokens(g, zoneTokens(library, 18, g.w, g.h)), a = tokens.find(t => t.id === 'p18-w1');
  assert.equal(a.snap, 'ink'); assert.ok(a.box.width < 15);
  assert.equal(selectInkTarget({ x: a.box.x + a.box.width / 2, y: a.box.y + a.box.height + 3 }, tokens).target?.id, 'p18-w1');
});

test('ink units: grid rulings removed, harakat attach to their own letter only (no chaining down a column)', () => {
  const g = page(13), units = inkUnits(components(inkMask(g), g.w, g.h));
  const col = units.filter(u => u.x0 > 345 && u.x1 < 380 && u.y0 > 240 && u.y1 < 460);
  assert.ok(col.length >= 5, `letters in the تَ column: ${col.length}`);
  assert.ok(col.every(u => u.y1 - u.y0 < 40), 'no unit spans several rows');
});

test('selection refuses a tip midway between two glyphs and a tip far from any glyph', () => {
  const toks = [{ id: 'a', text: 'ب', confidence: 0.9, box: { x: 100, y: 100, width: 10, height: 20 } }, { id: 'b', text: 'ت', confidence: 0.9, box: { x: 120, y: 100, width: 10, height: 20 } }];
  assert.equal(selectInkTarget({ x: 115, y: 110 }, toks).target, null);
  assert.equal(selectInkTarget({ x: 105, y: 160 }, toks).target, null);
  assert.equal(selectInkTarget({ x: 105, y: 123 }, toks).target.id, 'a');
});

test('offline pack manifest matches the shipped files byte-for-byte (a stale hash makes packs impossible to complete)', async () => {
  const { createHash } = await import('node:crypto'), { existsSync } = await import('node:fs');
  const packs = JSON.parse(readFileSync(root + 'data/offline-packs.json', 'utf8')).packs.filter(p => p.required || p.id === 'page-audio-ar');
  const bad = [];
  for (const p of packs) for (const f of p.files) {
    const fp = root + f.url.slice(2); if (!existsSync(fp)) { bad.push('missing ' + f.url); continue; }
    const b = readFileSync(fp); if (b.length !== f.bytes || createHash('sha256').update(b).digest('hex') !== f.sha256) bad.push('stale ' + f.url);
  }
  assert.deepEqual(bad, [], 'run: node scripts/build-offline-packs.cjs');
});
