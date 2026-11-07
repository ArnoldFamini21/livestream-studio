// AudioWorklet processor for the lossless (24-bit WAV) mic recording.
//
// It lives in its own same-origin file, loaded with
// new URL('./pcmWavTap.worklet.js', import.meta.url), because the production
// Content-Security-Policy (client/public/.htaccess) only allows scripts from
// 'self': AudioWorklet modules fall under script-src, so a blob: URL would be
// refused. Keep the processor name in sync with PCM_WAV_WORKLET_NAME in
// pcmWavRecorder.ts.

class StudioPcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    this.channels = Math.max(1, Math.min(2, processorOptions.channels || 1));
    this.batchFrames = processorOptions.batchFrames || 4800;
    this.active = true;
    this.reset();
    this.port.onmessage = (event) => {
      if (event.data === 'pause') { this.flush(); this.active = false; }
      else if (event.data === 'resume') { this.active = true; }
      else if (event.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }); }
    };
  }

  reset() {
    this.buffers = [];
    for (let c = 0; c < this.channels; c++) this.buffers.push(new Float32Array(this.batchFrames));
    this.filled = 0;
  }

  flush() {
    if (!this.filled) return;
    const out = this.buffers.map((buffer) => buffer.slice(0, this.filled));
    this.port.postMessage({ channels: out }, out.map((channel) => channel.buffer));
    this.reset();
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0] || [];
    const frames = input.length ? input[0].length : 128;
    for (let offset = 0; offset < frames;) {
      const count = Math.min(frames - offset, this.batchFrames - this.filled);
      for (let c = 0; c < this.channels; c++) {
        const source = input[c] || input[0];
        if (source) this.buffers[c].set(source.subarray(offset, offset + count), this.filled);
        else this.buffers[c].fill(0, this.filled, this.filled + count);
      }
      this.filled += count;
      offset += count;
      if (this.filled >= this.batchFrames) this.flush();
    }
    return true;
  }
}

registerProcessor('studio-pcm-tap', StudioPcmTap);
