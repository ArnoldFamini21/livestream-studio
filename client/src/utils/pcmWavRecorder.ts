import { createWavHeader, encodePcmFrames, WAV_HEADER_BYTES, type WavFormat } from './wavStream.ts';

/**
 * Lossless microphone capture: an AudioWorklet taps the raw (pre-processing)
 * mic at 48 kHz and the recorder streams 24-bit PCM into the track store,
 * one batch per second, so a long take is never held in memory.
 *
 * It exposes the small part of the MediaRecorder surface that the local
 * recorder uses (start/pause/resume/stop, state, mimeType, stream and the
 * dataavailable/stop/error handlers), so the existing track pipeline (folder
 * writer, browser backup, transfer to the host) works unchanged.
 */

export const WAV_MIME_TYPE = 'audio/wav';
export const PCM_WAV_SAMPLE_RATE = 48_000;

const WORKLET_NAME = 'studio-pcm-tap';
const WORKLET_SOURCE = `
class StudioPcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, Math.min(2, (options.processorOptions && options.processorOptions.channels) || 1));
    this.batchFrames = (options.processorOptions && options.processorOptions.batchFrames) || 4800;
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
registerProcessor('${WORKLET_NAME}', StudioPcmTap);
`;

const loadedContexts = new WeakSet<BaseAudioContext>();

async function ensureWorklet(context: AudioContext): Promise<void> {
  if (loadedContexts.has(context)) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    loadedContexts.add(context);
  } finally { URL.revokeObjectURL(url); }
}

export function isPcmWavRecordingSupported(): boolean {
  return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
    && typeof (AudioContext.prototype as { audioWorklet?: unknown }).audioWorklet !== 'undefined';
}

/** Ask for the same microphone with every voice-processing stage turned off. */
export async function openRawMicrophone(deviceId: string | undefined): Promise<MediaStreamTrack | null> {
  if (!deviceId || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: PCM_WAV_SAMPLE_RATE },
      },
    });
    return stream.getAudioTracks()[0] || null;
  } catch {
    return null;
  }
}

type RecorderState = 'inactive' | 'recording' | 'paused';

export interface PcmWavRecorderOptions {
  bitsPerSample?: WavFormat['bitsPerSample'];
  channels?: number;
  createContext?: () => AudioContext;
}

export class PcmWavRecorder {
  readonly mimeType = WAV_MIME_TYPE;
  readonly stream: MediaStream;
  state: RecorderState = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly format: WavFormat;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  private dataBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;

  constructor(stream: MediaStream, private readonly options: PcmWavRecorderOptions = {}) {
    this.stream = stream;
    const channels = Math.max(1, Math.min(2, options.channels ?? (stream.getAudioTracks()[0]?.getSettings().channelCount || 1)));
    this.format = { sampleRate: PCM_WAV_SAMPLE_RATE, channels, bitsPerSample: options.bitsPerSample ?? 24 };
  }

  /** Header with the real sizes; the track store swaps it in on finish. */
  headerPatch(): Blob {
    return new Blob([createWavHeader(this.format, this.dataBytes)], { type: WAV_MIME_TYPE });
  }

  headerBytes(): Uint8Array<ArrayBuffer> {
    return createWavHeader(this.format, this.dataBytes);
  }

  get recordedDataBytes(): number { return this.dataBytes; }

  start(timeslice = 1000): void {
    if (this.state !== 'inactive') throw new DOMException('Recorder already started', 'InvalidStateError');
    this.state = 'recording';
    // The placeholder header is the first chunk of the file.
    this.emit(new Blob([createWavHeader(this.format)], { type: WAV_MIME_TYPE }));
    this.starting = this.connect().catch((error) => {
      this.onerror?.(error);
      this.stop();
    });
    this.timer = setInterval(() => this.flushPending(), Math.max(250, timeslice));
  }

  pause(): void {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    this.node?.port.postMessage('pause');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.node?.port.postMessage('resume');
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    void (async () => {
      try { await this.starting; } catch { /* Reported by start. */ }
      await this.drainWorklet();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.flushPending();
      this.disconnect();
      this.onstop?.();
    })();
  }

  private async connect(): Promise<void> {
    const context = this.options.createContext?.() ?? new AudioContext({ sampleRate: PCM_WAV_SAMPLE_RATE, latencyHint: 'playback' });
    this.context = context;
    if (context.sampleRate !== PCM_WAV_SAMPLE_RATE) this.format.sampleRate = context.sampleRate;
    await ensureWorklet(context);
    if (this.state === 'inactive') return;
    this.source = context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: this.format.channels,
      channelCountMode: 'explicit',
      processorOptions: { channels: this.format.channels, batchFrames: Math.round(this.format.sampleRate / 10) },
    });
    this.node.port.onmessage = (event: MessageEvent<{ channels?: Float32Array[] }>) => {
      if (!event.data.channels) return;
      const bytes = encodePcmFrames(event.data.channels, this.format.bitsPerSample);
      this.pending.push(bytes);
      this.pendingBytes += bytes.byteLength;
    };
    // A silent sink keeps the graph pulling the worklet in every browser.
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(context.destination);
    if (this.state === 'paused') this.node.port.postMessage('pause');
    if (context.state === 'suspended') await context.resume().catch(() => {});
  }

  private drainWorklet(): Promise<void> {
    const node = this.node;
    if (!node) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      const previous = node.port.onmessage;
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.flushed) { clearTimeout(timeout); resolve(); return; }
        previous?.call(node.port, event);
      };
      node.port.postMessage('flush');
    });
  }

  private flushPending(): void {
    if (!this.pendingBytes) return;
    const blob = new Blob(this.pending as BlobPart[], { type: WAV_MIME_TYPE });
    this.dataBytes += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.emit(blob);
  }

  private emit(data: Blob): void {
    try { this.ondataavailable?.({ data }); } catch (error) { this.onerror?.(error); }
  }

  private disconnect(): void {
    try { this.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { this.node?.disconnect(); } catch { /* Already disconnected. */ }
    try { this.sink?.disconnect(); } catch { /* Already disconnected. */ }
    if (this.node) this.node.port.onmessage = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.node = null;
    this.source = null;
    this.sink = null;
  }
}

export { WAV_HEADER_BYTES };
