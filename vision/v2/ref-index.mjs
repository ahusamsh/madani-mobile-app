// Precomputed reference index (features + thumbnails of every reference page) in one binary file,
// so a phone never recomputes unchanging features at camera start. Produced in Chromium by
// vision/bench/build-index.cjs with the SAME computeFeatures() code the engine uses.
// Layout: "MVX1" | uint32 headerBytes | header JSON (utf-8) | pad to 4 | data blocks (offsets in header).
const MAGIC = 'MVX1';

export function serializeIndex(entries, meta = {}) {
  const parts = [], pages = []; let offset = 0;
  const put = (typed) => { const pad = (4 - (offset % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); offset += pad; } const o = offset; const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength); parts.push(bytes); offset += bytes.byteLength; return o; };
  for (const { pageId, url, size, features: f, thumb } of entries) {
    pages.push({ pageId, url, w: size.w, h: size.h, n: f.n, fw: f.w, fh: f.h, tw: thumb.w, th: thumb.h,
      x: put(f.x), y: put(f.y), angle: put(f.angle), level: put(f.level), desc: put(f.desc), thumb: put(thumb.d) });
  }
  const header = new TextEncoder().encode(JSON.stringify({ ...meta, pages }));
  const headLen = 8 + header.byteLength, pad = (4 - (headLen % 4)) % 4, out = new Uint8Array(headLen + pad + offset);
  out.set(new TextEncoder().encode(MAGIC), 0); new DataView(out.buffer).setUint32(4, header.byteLength, true); out.set(header, 8);
  let o = headLen + pad; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

export function parseIndex(buffer) {
  const u8 = new Uint8Array(buffer);
  if (new TextDecoder().decode(u8.subarray(0, 4)) !== MAGIC) throw new Error('not a vision reference index');
  const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(4, true), header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  const base = 8 + hl + ((4 - ((8 + hl) % 4)) % 4), ab = u8.buffer, b0 = u8.byteOffset + base;
  const pages = header.pages.map(p => ({
    pageId: p.pageId, url: p.url, size: { w: p.w, h: p.h },
    features: { n: p.n, w: p.fw, h: p.fh, x: new Float32Array(ab, b0 + p.x, p.n), y: new Float32Array(ab, b0 + p.y, p.n), angle: new Float32Array(ab, b0 + p.angle, p.n), level: new Uint8Array(ab, b0 + p.level, p.n), desc: new Uint32Array(ab, b0 + p.desc, p.n * 8) },
    thumb: { w: p.tw, h: p.th, d: new Uint8ClampedArray(ab, b0 + p.thumb, p.tw * p.th) },
  }));
  return { meta: { ...header, pages: undefined }, pages };
}
