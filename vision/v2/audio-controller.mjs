// Audio controller, separate from vision. Plays ONLY original clip files.
// Policy:
//  - unlock() must be called from the user gesture that starts the camera (Chrome/Android/iOS autoplay rules)
//  - preload(clips) fetches + decodes likely clips (current page) so playback starts without network/decoding delay
//  - play(clip) cancels whatever is playing or pending; a slow request that finishes after a newer one is DROPPED
//    (token check), so an old word can never sound after the pointer has moved on
//  - a clip that cannot be fetched/decoded is reported as 'missing-file' and nothing else is played
//  - Web Audio (AudioBuffer) is used when available, HTMLAudioElement otherwise
export class AudioController {
  constructor({ resolveUrl = u => u, fetchImpl = (...a) => fetch(...a), AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext, AudioImpl = globalThis.Audio, now = () => performance.now(), maxBuffers = 80, onEvent = () => {} } = {}) {
    Object.assign(this, { resolveUrl, fetchImpl, AudioContextImpl, AudioImpl, now, maxBuffers, onEvent });
    this.buffers = new Map(); this.inflight = new Map(); this.missing = new Set();
    this.token = 0; this.current = null; this.enabled = true; this.ctx = null; this.timings = [];
  }
  async unlock() {
    if (this.AudioContextImpl && !this.ctx) this.ctx = new this.AudioContextImpl();
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate || 22050), s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    }
    return !!this.ctx || !!this.AudioImpl;
  }
  setEnabled(on) { this.enabled = !!on; if (!on) this.stop(); }
  async load(clip) {
    if (this.buffers.has(clip)) { const b = this.buffers.get(clip); this.buffers.delete(clip); this.buffers.set(clip, b); return b; }
    if (this.missing.has(clip)) throw new Error('missing-file');
    if (this.inflight.has(clip)) return this.inflight.get(clip);
    const p = (async () => {
      const res = await this.fetchImpl(this.resolveUrl(clip));
      if (!res || !res.ok) throw new Error('missing-file');
      const bytes = await res.arrayBuffer();
      if (!this.ctx) return { bytes };
      return await new Promise((ok, bad) => { const r = this.ctx.decodeAudioData(bytes.slice(0), ok, bad); if (r?.then) r.then(ok, bad); });
    })();
    this.inflight.set(clip, p);
    try {
      const b = await p; this.buffers.set(clip, b);
      while (this.buffers.size > this.maxBuffers) this.buffers.delete(this.buffers.keys().next().value);
      return b;
    } catch (e) { this.missing.add(clip); throw new Error('missing-file'); }
    finally { this.inflight.delete(clip); }
  }
  /** Fire-and-forget preloading; failures are remembered as missing files. */
  preload(clips) { return Promise.allSettled([...new Set(clips)].filter(c => c && !this.buffers.has(c) && !this.missing.has(c)).map(c => this.load(c))); }
  stop() {
    this.token++;
    const c = this.current; this.current = null;
    try { c?.source?.stop(0); } catch {}
    try { if (c?.element) { c.element.pause(); c.element.src = ''; } } catch {}
  }
  /** Returns {status:'playing'|'missing-file'|'cancelled'|'disabled', latencyMs}. */
  async play(clip, { key = clip, requestedAt = this.now() } = {}) {
    if (!this.enabled) return { status: 'disabled' };
    this.stop(); const token = this.token;
    const fromCache = this.buffers.has(clip);
    let buf;
    try { buf = await this.load(clip); } catch { if (token === this.token) this.onEvent({ type: 'missing-file', clip, key }); return { status: 'missing-file' }; }
    if (token !== this.token) return { status: 'cancelled' }; // a newer request superseded this one while loading
    let current;
    if (this.ctx && buf && !buf.bytes) {
      const source = this.ctx.createBufferSource(); source.buffer = buf; source.connect(this.ctx.destination);
      source.onended = () => { if (this.current?.source === source) { this.current = null; this.onEvent({ type: 'ended', clip, key }); } };
      source.start(0); current = { source, clip, key };
    } else {
      const el = new this.AudioImpl(this.resolveUrl(clip)); el.onended = () => { if (this.current?.element === el) { this.current = null; this.onEvent({ type: 'ended', clip, key }); } };
      await el.play(); if (token !== this.token) { el.pause(); return { status: 'cancelled' }; }
      current = { element: el, clip, key };
    }
    this.current = current;
    const latencyMs = this.now() - requestedAt; this.timings.push({ latencyMs, fromCache }); if (this.timings.length > 200) this.timings.shift();
    this.onEvent({ type: 'started', clip, key, latencyMs, fromCache });
    return { status: 'playing', latencyMs, fromCache };
  }
}
