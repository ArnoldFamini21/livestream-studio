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

/** Must match registerProcessor() in pcmWavTap.worklet.js. */
export const PCM_WAV_WORKLET_NAME = 'studio-pcm-tap';
const WORKLET_NAME = PCM_WAV_WORKLET_NAME;
/**
 * Same-origin module URL (Vite emits it as an asset). The production CSP only
 * lets scripts, worklets included, load from 'self', so a blob: URL is refused.
 */
export const PCM_WAV_WORKLET_URL = new URL('./pcmWavTap.worklet.js', import.meta.url);

const loadedContexts = new WeakSet<BaseAudioContext>();

async function ensureWorklet(context: AudioContext): Promise<void> {
  if (loadedContexts.has(context)) return;
  await context.audioWorklet.addModule(PCM_WAV_WORKLET_URL.href);
  loadedContexts.add(context);
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
  /**
   * The participant-facing mic track (the one mute toggles). The raw capture
   * is a separate getUserMedia track that mute never touches, so while this
   * track is disabled or has ended the recorder writes silence instead of
   * the live microphone. The timeline keeps its length either way.
   */
  gateTrack?: MediaStreamTrack | null;
}

/** True when the gate says the microphone must not be heard right now. */
export function isPcmGateClosed(gate: Pick<MediaStreamTrack, 'enabled' | 'readyState'> | null | undefined): boolean {
  if (!gate) return false;
  return !gate.enabled || gate.readyState === 'ended';
}

/** Replace a batch with silence of the same length while the gate is closed. */
export function gatePcmChannels(
  channels: Float32Array[],
  gate: Pick<MediaStreamTrack, 'enabled' | 'readyState'> | null | undefined,
): Float32Array[] {
  if (!isPcmGateClosed(gate)) return channels;
  return channels.map((channel) => new Float32Array(channel.length));
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
      const bytes = encodePcmFrames(gatePcmChannels(event.data.channels, this.options.gateTrack), this.format.bitsPerSample);
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
