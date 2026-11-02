// Camera frames for the vision worker: camera selection/switching, frame grabbing at an adaptive size.
export class FrameSource {
  constructor(video) { this.video = video; this.stream = null; this.devices = []; this.deviceId = null; this.canvas = null; }
  async listCameras() {
    try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { this.devices = []; }
    return this.devices;
  }
  async start(deviceId = null) {
    this.stop();
    const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...video, width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    this.deviceId = this.stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? deviceId;
    this.video.srcObject = this.stream; await this.video.play();
    await this.listCameras();
  }
  async switchCamera() {
    if (this.devices.length < 2) return false;
    const i = this.devices.findIndex(d => d.deviceId === this.deviceId), next = this.devices[(i + 1) % this.devices.length];
    await this.start(next.deviceId); return true;
  }
  stop() { this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; if (this.video) this.video.srcObject = null; }
  get ready() { return this.video.readyState >= 2 && this.video.videoWidth > 0; }
  /** Grab one frame scaled to `width`. Prefers a transferable ImageBitmap; falls back to canvas pixels. */
  async grab(width) {
    const v = this.video, w = Math.round(width), h = Math.round((v.videoHeight * w) / v.videoWidth);
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined' && !this.noBitmap) {
      try { return { width: w, height: h, bitmap: await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }) }; } catch { this.noBitmap = true; }
    }
    if (!this.canvas) { this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }); }
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(v, 0, 0, w, h);
    return { width: w, height: h, buffer: this.ctx.getImageData(0, 0, w, h).data.buffer };
  }
}

/** Picks the analysis width from measured processing time (keeps accuracy unless the device is too slow). */
export class AdaptiveRate {
  constructor({ widths = [360, 420, 480], targetMs = 120 } = {}) { this.widths = widths; this.i = widths.length - 1; this.targetMs = targetMs; this.ema = null; this.n = 0; }
  get width() { return this.widths[this.i]; }
  record(ms) {
    this.ema = this.ema === null ? ms : this.ema * 0.85 + ms * 0.15; this.n++;
    if (this.n % 10) return;
    if (this.ema > this.targetMs * 1.4 && this.i > 0) this.i--;
    else if (this.ema < this.targetMs * 0.6 && this.i < this.widths.length - 1) this.i++;
  }
}
