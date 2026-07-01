import {
  getVideoQualityPreset,
  type VideoQualityPresetId,
} from './mediaPreferences.ts';
import {
  getPreferredWebCodecsCodec,
  type BrowserVideoEncoderConfigLike,
  type BrowserVideoEncoderHardwareAcceleration,
} from './videoEncodingCapabilities.ts';

type EncodedVideoChunkType = 'key' | 'delta' | string;

interface EncodedVideoChunkLike {
  type?: EncodedVideoChunkType;
  timestamp?: number;
  duration?: number;
  byteLength?: number;
  copyTo?: (destination: Uint8Array) => void;
}

interface VideoFrameLike {
  timestamp?: number;
  duration?: number;
  close?: () => void;
}

interface VideoEncoderInitLike {
  output: (chunk: EncodedVideoChunkLike) => void;
  error: (error: unknown) => void;
}

interface VideoEncoderLike {
  configure: (config: BrowserVideoEncoderConfigLike) => void;
  encode: (frame: VideoFrameLike, options?: { keyFrame?: boolean }) => void;
  flush: () => Promise<void>;
  close: () => void;
}

interface VideoEncoderConstructorLike {
  new (init: VideoEncoderInitLike): VideoEncoderLike;
  isConfigSupported?: (configuration: BrowserVideoEncoderConfigLike) => Promise<{ supported?: boolean; config?: BrowserVideoEncoderConfigLike }>;
}

interface ReadableStreamReaderLike {
  read: () => Promise<{ done?: boolean; value?: VideoFrameLike }>;
  cancel?: () => Promise<void> | void;
}

interface MediaStreamTrackProcessorLike {
  readable: {
    getReader: () => ReadableStreamReaderLike;
  };
}

interface MediaStreamTrackProcessorConstructorLike {
  new (init: { track: MediaStreamTrack }): MediaStreamTrackProcessorLike;
}

export interface WebCodecsRecordingEnvironment {
  VideoEncoder?: VideoEncoderConstructorLike | null;
  MediaStreamTrackProcessor?: MediaStreamTrackProcessorConstructorLike | null;
  now?: () => number;
}

export interface WebCodecsVideoRecorderOptions {
  stream: MediaStream;
  presetId?: VideoQualityPresetId;
  contentType?: string;
  bitsPerSecond?: number;
  hardwareAcceleration?: BrowserVideoEncoderHardwareAcceleration;
  keyFrameIntervalFrames?: number;
  maxBufferedBytes?: number;
  environment?: WebCodecsRecordingEnvironment;
}

export interface WebCodecsEncodedChunk {
  type: EncodedVideoChunkType;
  timestamp: number;
  duration: number | null;
  byteLength: number;
  data: Uint8Array;
}

export interface WebCodecsVideoRecorderConfig {
  track: MediaStreamTrack;
  config: BrowserVideoEncoderConfigLike;
  mimeType: string;
}

export interface WebCodecsVideoRecorderResult {
  blob: Blob;
  mimeType: string;
  config: BrowserVideoEncoderConfigLike;
  chunks: WebCodecsEncodedChunk[];
  framesEncoded: number;
  durationMs: number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024 * 1024;
const DEFAULT_KEYFRAME_INTERVAL_FRAMES = 60;

function getCurrentEnvironment(): WebCodecsRecordingEnvironment {
  const root = typeof globalThis === 'undefined'
    ? {}
    : globalThis as unknown as WebCodecsRecordingEnvironment;
  return {
    VideoEncoder: root.VideoEncoder || null,
    MediaStreamTrackProcessor: root.MediaStreamTrackProcessor || null,
    now: () => Date.now(),
  };
}

function getLiveVideoTrack(stream: MediaStream): MediaStreamTrack | null {
  return stream.getVideoTracks().find((track) => track.readyState === 'live') || null;
}

function readTrackSettings(track: MediaStreamTrack): MediaTrackSettings {
  try {
    return typeof track.getSettings === 'function' ? track.getSettings() : {};
  } catch {
    return {};
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function getWebCodecsBitstreamMimeType(codec: string): string {
  const normalized = codec.toLowerCase();
  if (normalized.startsWith('vp09') || normalized.includes('vp9')) return 'video/x-vp9';
  if (normalized.startsWith('vp8')) return 'video/x-vp8';
  if (normalized.startsWith('avc') || normalized.startsWith('h264')) return 'video/avc';
  return 'application/octet-stream';
}

export function canUseWebCodecsVideoRecorder(
  environment: WebCodecsRecordingEnvironment = getCurrentEnvironment()
): boolean {
  return Boolean(environment.VideoEncoder && environment.MediaStreamTrackProcessor);
}

export function resolveWebCodecsVideoRecorderConfig(
  options: WebCodecsVideoRecorderOptions
): WebCodecsVideoRecorderConfig | null {
  const track = getLiveVideoTrack(options.stream);
  if (!track) return null;

  const preset = getVideoQualityPreset(options.presetId);
  const settings = readTrackSettings(track);
  const width = boundedInteger(settings.width, preset.width, 16, preset.width);
  const height = boundedInteger(settings.height, preset.height, 16, preset.height);
  const framerate = boundedInteger(settings.frameRate, preset.frameRate, 1, preset.frameRate);
  const bitrate = boundedInteger(options.bitsPerSecond, preset.id === '4k' ? 24_000_000 : preset.id === '720p' ? 4_000_000 : 8_000_000, 64_000, 80_000_000);
  const codec = getPreferredWebCodecsCodec(options.contentType);

  const config: BrowserVideoEncoderConfigLike = {
    codec,
    width,
    height,
    bitrate,
    framerate,
    hardwareAcceleration: options.hardwareAcceleration || 'prefer-hardware',
  };

  return {
    track,
    config,
    mimeType: getWebCodecsBitstreamMimeType(codec),
  };
}

function copyEncodedChunk(chunk: EncodedVideoChunkLike): Uint8Array {
  const byteLength = boundedInteger(chunk.byteLength, 0, 0, DEFAULT_MAX_BUFFERED_BYTES);
  const data = new Uint8Array(byteLength);
  if (byteLength > 0 && typeof chunk.copyTo === 'function') {
    chunk.copyTo(data);
  }
  return data;
}

export class WebCodecsVideoTrackRecorder {
  private readonly options: Required<Pick<WebCodecsVideoRecorderOptions, 'keyFrameIntervalFrames' | 'maxBufferedBytes'>> & WebCodecsVideoRecorderOptions;
  private readonly environment: WebCodecsRecordingEnvironment;
  private encoder: VideoEncoderLike | null = null;
  private reader: ReadableStreamReaderLike | null = null;
  private readLoop: Promise<void> | null = null;
  private chunks: WebCodecsEncodedChunk[] = [];
  private totalBufferedBytes = 0;
  private framesEncoded = 0;
  private startedAt = 0;
  private stopped = false;
  private encoderError: Error | null = null;
  private config: WebCodecsVideoRecorderConfig | null = null;

  constructor(options: WebCodecsVideoRecorderOptions) {
    this.environment = options.environment || getCurrentEnvironment();
    this.options = {
      ...options,
      keyFrameIntervalFrames: boundedInteger(options.keyFrameIntervalFrames, DEFAULT_KEYFRAME_INTERVAL_FRAMES, 1, 600),
      maxBufferedBytes: boundedInteger(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, 1024 * 1024, DEFAULT_MAX_BUFFERED_BYTES),
      environment: this.environment,
    };
  }

  async start(): Promise<WebCodecsVideoRecorderConfig> {
    if (!canUseWebCodecsVideoRecorder(this.environment)) {
      throw new Error('WebCodecs VideoEncoder and MediaStreamTrackProcessor are required.');
    }
    const resolved = resolveWebCodecsVideoRecorderConfig(this.options);
    if (!resolved) {
      throw new Error('A live video track is required for WebCodecs recording.');
    }

    const Encoder = this.environment.VideoEncoder!;
    if (Encoder.isConfigSupported) {
      const support = await Encoder.isConfigSupported(resolved.config);
      if (support.supported === false) {
        throw new Error('This WebCodecs video encoder configuration is not supported.');
      }
      if (support.config) resolved.config = support.config;
    }

    const Processor = this.environment.MediaStreamTrackProcessor!;
    const processor = new Processor({ track: resolved.track });
    this.reader = processor.readable.getReader();
    this.encoder = new Encoder({
      output: (chunk) => this.handleOutput(chunk),
      error: (error) => {
        this.encoderError = error instanceof Error ? error : new Error(String(error));
        this.stopped = true;
      },
    });
    this.encoder.configure(resolved.config);
    this.startedAt = this.environment.now?.() ?? Date.now();
    this.config = resolved;
    this.readLoop = this.readFrames();
    return resolved;
  }

  private handleOutput(chunk: EncodedVideoChunkLike) {
    const data = copyEncodedChunk(chunk);
    this.totalBufferedBytes += data.byteLength;
    if (this.totalBufferedBytes > this.options.maxBufferedBytes) {
      throw new Error('WebCodecs recording exceeded the buffered chunk limit.');
    }
    this.chunks.push({
      type: chunk.type || 'delta',
      timestamp: Number.isFinite(chunk.timestamp) ? Math.round(Number(chunk.timestamp)) : 0,
      duration: Number.isFinite(chunk.duration) ? Math.round(Number(chunk.duration)) : null,
      byteLength: data.byteLength,
      data,
    });
  }

  private async readFrames() {
    if (!this.reader || !this.encoder) return;
    while (!this.stopped) {
      if (this.encoderError) throw this.encoderError;
      const frame = await this.reader.read();
      if (frame.done || !frame.value) return;
      try {
        this.encoder.encode(frame.value, {
          keyFrame: this.framesEncoded % this.options.keyFrameIntervalFrames === 0,
        });
        this.framesEncoded += 1;
      } finally {
        frame.value.close?.();
      }
    }
  }

  async stop(options: { drain?: boolean } = {}): Promise<WebCodecsVideoRecorderResult> {
    if (!options.drain) {
      this.stopped = true;
      await this.reader?.cancel?.();
    }
    await this.readLoop?.catch((error) => {
      if (!this.stopped) throw error;
    });
    this.stopped = true;
    if (this.encoderError) throw this.encoderError;
    await this.encoder?.flush();
    this.encoder?.close();

    const mimeType = this.config?.mimeType || 'application/octet-stream';
    const durationMs = Math.max(0, Math.round((this.environment.now?.() ?? Date.now()) - this.startedAt));
    const blobParts = this.chunks.map((chunk) => {
      const buffer = new ArrayBuffer(chunk.data.byteLength);
      new Uint8Array(buffer).set(chunk.data);
      return buffer;
    });
    return {
      blob: new Blob(blobParts, { type: mimeType }),
      mimeType,
      config: this.config?.config || resolveWebCodecsVideoRecorderConfig(this.options)?.config || {
        codec: 'vp8',
        width: 0,
        height: 0,
        bitrate: 0,
        framerate: 0,
      },
      chunks: [...this.chunks],
      framesEncoded: this.framesEncoded,
      durationMs,
    };
  }
}

export function createWebCodecsVideoTrackRecorder(
  options: WebCodecsVideoRecorderOptions
): WebCodecsVideoTrackRecorder {
  return new WebCodecsVideoTrackRecorder(options);
}
