import type { MediaStreamAudioTrackSource, MediaStreamVideoTrackSource, Output } from 'mediabunny';

type Mediabunny = typeof import('mediabunny');
type VideoTrack = ConstructorParameters<Mediabunny['MediaStreamVideoTrackSource']>[0];
type AudioTrack = ConstructorParameters<Mediabunny['MediaStreamAudioTrackSource']>[0];

const MIME_TYPE = 'video/webm;codecs=vp9,opus';
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_UNWRITTEN_BYTES = 32 * 1024 * 1024;
const MAX_TRACK_LEAD_SECONDS = 5;

export interface StreamingWebCodecsRecorderOptions {
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
}

/** A single take. Support checks are asynchronous, but capture starts in the caller's start turn. */
export async function prepareStreamingWebCodecsRecorder(
  stream: MediaStream,
  options: StreamingWebCodecsRecorderOptions,
): Promise<StreamingWebCodecsRecorder | null> {
  if (!('MediaStreamTrackProcessor' in globalThis) || typeof VideoEncoder !== 'function' || typeof AudioEncoder !== 'function') return null;
  if (!Number.isFinite(options.videoBitsPerSecond) || options.videoBitsPerSecond <= 0
    || !Number.isFinite(options.audioBitsPerSecond) || options.audioBitsPerSecond <= 0) return null;

  const [video, extraVideo] = stream.getVideoTracks();
  const [audio, extraAudio] = stream.getAudioTracks();
  if (!video || !audio || extraVideo || extraAudio || video.kind !== 'video' || audio.kind !== 'audio'
    || video.readyState !== 'live' || audio.readyState !== 'live') return null;
  try {
    const { width, height, frameRate } = video.getSettings();
    // Web Audio destination tracks can omit nominal settings. The encoder
    // still uses the actual AudioData sample format when capture starts.
    const { sampleRate = 48_000, channelCount = 2 } = audio.getSettings();
    if (!width || !height) return null;
    const library = await import('mediabunny');
    const [videoSupported, audioSupported] = await Promise.all([
      library.canEncodeVideo('vp9', { width, height, frameRate, quality: options.videoBitsPerSecond, latencyMode: 'realtime' }),
      library.canEncodeAudio('opus', { sampleRate, numberOfChannels: channelCount, quality: options.audioBitsPerSecond }),
    ]);
    return videoSupported && audioSupported ? new StreamingWebCodecsRecorder(stream, video as VideoTrack, audio as AudioTrack, options, library) : null;
  } catch {
    return null;
  }
}

/** Emits the append-only WebM bytes created from the actual input samples. */
export class StreamingWebCodecsRecorder extends EventTarget {
  readonly mimeType = MIME_TYPE;
  state: RecordingState = 'inactive';
  onstart: ((event: Event) => void) | null = null;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  private output: Output | null = null;
  private video: MediaStreamVideoTrackSource | null = null;
  private audio: MediaStreamAudioTrackSource | null = null;
  private starting: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Blob[] = [];
  private pendingBytes = 0;
  private unwrittenBytes = 0;
  private trackTime = { video: 0, audio: 0 };
  private failed = false;

  constructor(
    readonly stream: MediaStream,
    private readonly videoTrack: VideoTrack,
    private readonly audioTrack: AudioTrack,
    private readonly options: StreamingWebCodecsRecorderOptions,
    private readonly library: Mediabunny,
  ) {
    super();
    this.addEventListener('start', (event) => this.onstart?.(event));
    this.addEventListener('dataavailable', (event) => this.ondataavailable?.(event as BlobEvent));
    this.addEventListener('stop', (event) => this.onstop?.(event));
    this.addEventListener('error', (event) => this.onerror?.(event as ErrorEvent));
  }

  start(timeslice = 1000): void {
    if (this.output) throw new DOMException('This recorder has already started.', 'InvalidStateError');
    if (this.videoTrack.readyState !== 'live' || this.audioTrack.readyState !== 'live') {
      throw new DOMException('The recording input ended before capture started.', 'NotSupportedError');
    }
    const { Output, WebMOutputFormat, AppendOnlyStreamTarget, MediaStreamVideoTrackSource, MediaStreamAudioTrackSource } = this.library;
    const target = new AppendOnlyStreamTarget(new WritableStream({
      write: (bytes) => this.append(bytes),
    }));
    const output = new Output({ format: new WebMOutputFormat({ appendOnly: true }), target });
    const video = new MediaStreamVideoTrackSource(this.videoTrack, {
      codec: 'vp9',
      bitrate: this.options.videoBitsPerSecond,
      keyFrameInterval: 1,
      onEncodedPacket: (packet) => this.notePacket('video', packet),
    }, { frameRate: null });
    const audio = new MediaStreamAudioTrackSource(this.audioTrack, {
      codec: 'opus',
      bitrate: this.options.audioBitsPerSecond,
      onEncodedPacket: (packet) => this.notePacket('audio', packet),
    });
    output.addVideoTrack(video);
    output.addAudioTrack(audio);
    this.output = output;
    this.video = video;
    this.audio = audio;
    this.state = 'recording';
    void video.errorPromise.catch((error) => this.fail(error));
    void audio.errorPromise.catch((error) => this.fail(error));
    this.starting = output.start();
    void this.starting.then(() => {
      if (this.state !== 'inactive') this.dispatchEvent(new Event('start'));
    }, (error) => this.fail(error));
    const interval = Number.isFinite(timeslice) ? Math.max(50, Math.min(timeslice, 1000)) : 1000;
    this.timer = setInterval(() => this.flushBatch(), interval);
    this.videoTrack.addEventListener('ended', this.onInputEnded, { once: true });
    this.audioTrack.addEventListener('ended', this.onInputEnded, { once: true });
  }

  pause(): void {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    this.video?.pause();
    this.audio?.pause();
    this.dispatchEvent(new Event('pause'));
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.video?.resume();
    this.audio?.resume();
    this.dispatchEvent(new Event('resume'));
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // Close intake for both sources in this turn. Output.finalize drains both
    // encoders before it closes the muxer and the append-only byte stream.
    this.video?.pause();
    this.audio?.pause();
    void this.finish();
  }

  private readonly onInputEnded = (): void => this.stop();

  private notePacket(lane: 'video' | 'audio', packet: { timestamp: number; duration: number; byteLength: number }): void {
    if (this.state === 'inactive') return;
    this.trackTime[lane] = Math.max(this.trackTime[lane], packet.timestamp + packet.duration);
    this.unwrittenBytes += packet.byteLength;
    if (Math.abs(this.trackTime.video - this.trackTime.audio) <= MAX_TRACK_LEAD_SECONDS
      && this.unwrittenBytes <= MAX_UNWRITTEN_BYTES) return;
    // Leave the current encoder callback before asking it to drain.
    queueMicrotask(() => {
      if (this.state !== 'inactive') this.fail(new Error('The recording encoder could not keep up with this input.'));
    });
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const message = error instanceof Error ? error.message : String(error);
    this.dispatchEvent(new ErrorEvent('error', { error, message }));
    this.stop();
  }

  private append(bytes: Uint8Array): void {
    if (!bytes.byteLength) return;
    // Snapshot the muxer's byte range before its writer can reuse the buffer.
    this.pending.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    this.pendingBytes += bytes.byteLength;
    this.unwrittenBytes = Math.max(0, this.unwrittenBytes - bytes.byteLength);
    if (this.pendingBytes >= MAX_BATCH_BYTES) this.flushBatch();
  }

  private flushBatch(): void {
    if (!this.pendingBytes) return;
    const data = new Blob(this.pending, { type: this.mimeType });
    this.pending = [];
    this.pendingBytes = 0;
    this.dispatchEvent(new BlobEvent('dataavailable', { data }));
  }

  private async finish(): Promise<void> {
    try {
      await this.starting;
      await this.output?.finalize();
    } catch (error) {
      this.fail(error);
      if (this.output?.state === 'started') await this.output.cancel().catch(() => {});
    } finally {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.audioTrack.removeEventListener('ended', this.onInputEnded);
      this.videoTrack.removeEventListener('ended', this.onInputEnded);
      this.flushBatch();
      this.dispatchEvent(new Event('stop'));
    }
  }
}
