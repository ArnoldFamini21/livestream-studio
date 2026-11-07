export type RecordingCaptureSourceKind = 'audio' | 'video' | 'screen' | 'program' | 'iso';

export interface RecordingCaptureTrackSettings {
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: number;
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export interface RecordingCaptureTrackMetadata {
  kind: string;
  label: string;
  readyState: string;
  enabled: boolean;
  muted: boolean;
  settings: RecordingCaptureTrackSettings;
}

export interface RecordingCaptureEncoderMetadata {
  pipeline: 'media-recorder' | 'webcodecs';
  container: 'mp4' | 'm4a' | 'webm' | 'ogg' | 'raw-bitstream' | 'browser';
  codec?: string;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  fallbackReason?: string;
}

/**
 * Precise timing for aligning tracks recorded on different machines.
 * Times are milliseconds since the epoch on the recording machine's clock,
 * derived from performance.timeOrigin + performance.now() (monotonic within
 * the page, unaffected by clock adjustments during the take).
 */
export interface RecordingCaptureTimeline {
  startMs: number;
  stopMs?: number;
  /** performance.timeOrigin of the recording page. */
  timeOrigin: number;
  /** Pause intervals; the file contains no media for them. */
  pauses: Array<{ startMs: number; endMs?: number }>;
  /** 0 for the first file of a source; device changes start a new segment. */
  segmentIndex: number;
  /** Add to this track's times to express them on the host's clock. */
  clockOffsetMs?: number;
}

export interface RecordingCaptureMetadata {
  sourceId: string;
  sourceKind: RecordingCaptureSourceKind;
  sourceLabel: string;
  mimeType: string;
  requestedBitsPerSecond: number | null;
  startedAt: string;
  stoppedAt?: string;
  durationMs?: number;
  trackCount: number;
  tracks: RecordingCaptureTrackMetadata[];
  encoder?: RecordingCaptureEncoderMetadata;
  timeline?: RecordingCaptureTimeline;
}

interface RecordingCaptureMetadataInput {
  sourceId: string;
  sourceKind: RecordingCaptureSourceKind;
  sourceLabel: string;
  stream: MediaStream;
  mimeType: string;
  requestedBitsPerSecond?: number;
  startedAt: string;
  encoder?: RecordingCaptureEncoderMetadata;
}

function safeText(value: unknown, fallback: string, maxLength = 160): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, ' ') : '';
  return (text || fallback).slice(0, maxLength);
}

function safeIsoDate(value: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof value !== 'string') return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function safePositiveNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Number(numberValue.toFixed(3)) : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizeTrackSettings(settings: MediaTrackSettings | Record<string, unknown> | undefined): RecordingCaptureTrackSettings {
  if (!settings) return {};
  return {
    width: safePositiveNumber(settings.width),
    height: safePositiveNumber(settings.height),
    frameRate: safePositiveNumber(settings.frameRate),
    aspectRatio: safePositiveNumber(settings.aspectRatio),
    sampleRate: safePositiveNumber(settings.sampleRate),
    sampleSize: safePositiveNumber(settings.sampleSize),
    channelCount: safePositiveNumber(settings.channelCount),
    echoCancellation: safeBoolean(settings.echoCancellation),
    noiseSuppression: safeBoolean(settings.noiseSuppression),
    autoGainControl: safeBoolean(settings.autoGainControl),
  };
}

function normalizeEncoderMetadata(value: unknown): RecordingCaptureEncoderMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<RecordingCaptureEncoderMetadata>;
  const pipeline = input.pipeline === 'webcodecs' ? 'webcodecs' : input.pipeline === 'media-recorder' ? 'media-recorder' : undefined;
  if (!pipeline) return undefined;
  const container = input.container === 'mp4' || input.container === 'm4a' || input.container === 'webm' || input.container === 'ogg' || input.container === 'raw-bitstream' || input.container === 'browser'
    ? input.container
    : 'browser';
  const hardwareAcceleration = input.hardwareAcceleration === 'no-preference' || input.hardwareAcceleration === 'prefer-hardware' || input.hardwareAcceleration === 'prefer-software'
    ? input.hardwareAcceleration
    : undefined;

  return {
    pipeline,
    container,
    ...(input.codec ? { codec: safeText(input.codec, 'codec', 80) } : {}),
    ...(hardwareAcceleration ? { hardwareAcceleration } : {}),
    ...(input.fallbackReason ? { fallbackReason: safeText(input.fallbackReason, 'Fallback active', 240) } : {}),
  };
}

function collectTrackMetadata(track: MediaStreamTrack): RecordingCaptureTrackMetadata {
  let settings: MediaTrackSettings | Record<string, unknown> | undefined;
  try {
    settings = typeof track.getSettings === 'function' ? track.getSettings() : undefined;
  } catch {
    settings = undefined;
  }

  return {
    kind: safeText(track.kind, 'unknown', 32),
    label: safeText(track.kind ? `${track.kind} track` : 'Track', 'Track'),
    readyState: safeText(track.readyState, 'unknown', 32),
    enabled: track.enabled !== false,
    muted: track.muted === true,
    settings: sanitizeTrackSettings(settings),
  };
}

export function createRecordingCaptureMetadata(input: RecordingCaptureMetadataInput): RecordingCaptureMetadata {
  const tracks = input.stream.getTracks().map(collectTrackMetadata);
  const requestedBitsPerSecond = Number.isFinite(input.requestedBitsPerSecond)
    ? Math.max(0, Math.floor(input.requestedBitsPerSecond || 0))
    : null;
  const encoder = normalizeEncoderMetadata(input.encoder);

  return {
    sourceId: safeText(input.sourceId, 'recording-source', 120),
    sourceKind: input.sourceKind,
    sourceLabel: safeText(input.sourceLabel, 'Recording source'),
    mimeType: safeText(input.mimeType, 'application/octet-stream', 120),
    requestedBitsPerSecond,
    startedAt: safeIsoDate(input.startedAt),
    trackCount: tracks.length,
    tracks,
    ...(encoder ? { encoder } : {}),
  };
}

export function finalizeRecordingCaptureMetadata(
  capture: RecordingCaptureMetadata,
  stoppedAt: string
): RecordingCaptureMetadata {
  const safeStoppedAt = safeIsoDate(stoppedAt);
  const startedMs = Date.parse(capture.startedAt);
  const stoppedMs = Date.parse(safeStoppedAt);
  const timeline = capture.timeline;
  if (timeline) {
    const stopMs = timeline.stopMs ?? stoppedMs;
    // Recorded media excludes paused time.
    const pausedMs = timeline.pauses.reduce((sum, pause) => sum + Math.max(0, (pause.endMs ?? stopMs) - pause.startMs), 0);
    return {
      ...capture,
      stoppedAt: safeStoppedAt,
      durationMs: Math.max(0, Math.round(stopMs - timeline.startMs - pausedMs)),
      timeline: {
        ...timeline,
        stopMs,
        pauses: timeline.pauses.map((pause) => ({ startMs: pause.startMs, endMs: pause.endMs ?? stopMs })),
      },
    };
  }
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(stoppedMs)
    ? Math.max(0, Math.round(stoppedMs - startedMs))
    : undefined;

  return {
    ...capture,
    stoppedAt: safeStoppedAt,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function safeEpochMs(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Number(numberValue.toFixed(3)) : undefined;
}

export function normalizeRecordingCaptureTimeline(value: unknown): RecordingCaptureTimeline | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<RecordingCaptureTimeline>;
  const startMs = safeEpochMs(input.startMs);
  if (startMs === undefined) return undefined;
  const stopMs = safeEpochMs(input.stopMs);
  const pauses = Array.isArray(input.pauses)
    ? input.pauses.slice(0, 2000).flatMap((pause) => {
        const pauseStart = safeEpochMs(pause?.startMs);
        if (pauseStart === undefined) return [];
        const pauseEnd = safeEpochMs(pause?.endMs);
        return [{ startMs: pauseStart, ...(pauseEnd !== undefined && pauseEnd >= pauseStart ? { endMs: pauseEnd } : {}) }];
      })
    : [];
  const clockOffsetMs = Number(input.clockOffsetMs);
  return {
    startMs,
    ...(stopMs !== undefined && stopMs >= startMs ? { stopMs } : {}),
    timeOrigin: safeEpochMs(input.timeOrigin) ?? startMs,
    pauses,
    segmentIndex: Number.isSafeInteger(input.segmentIndex) && Number(input.segmentIndex) >= 0 ? Number(input.segmentIndex) : 0,
    ...(Number.isFinite(clockOffsetMs) && Math.abs(clockOffsetMs) < 86_400_000 ? { clockOffsetMs: Number(clockOffsetMs.toFixed(3)) } : {}),
  };
}

export function normalizeRecordingCaptureMetadata(value: unknown): RecordingCaptureMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<RecordingCaptureMetadata>;
  const sourceKind = input.sourceKind;
  if (!sourceKind || !['audio', 'video', 'screen', 'program', 'iso'].includes(sourceKind)) return undefined;
  const tracks = Array.isArray(input.tracks)
    ? input.tracks.slice(0, 16).map((track): RecordingCaptureTrackMetadata => {
        const candidate = (track && typeof track === 'object' ? track : {}) as Partial<RecordingCaptureTrackMetadata>;
        return {
          kind: safeText(candidate.kind, 'unknown', 32),
          label: safeText(candidate.label, 'Track'),
          readyState: safeText(candidate.readyState, 'unknown', 32),
          enabled: candidate.enabled !== false,
          muted: candidate.muted === true,
          settings: sanitizeTrackSettings(candidate.settings),
        };
      })
    : [];
  const requestedBitsPerSecond = Number.isFinite(input.requestedBitsPerSecond)
    ? Math.max(0, Math.floor(Number(input.requestedBitsPerSecond)))
    : null;
  const startedAt = safeIsoDate(input.startedAt);
  const stoppedAt = input.stoppedAt ? safeIsoDate(input.stoppedAt) : undefined;
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(Number(input.durationMs))) : undefined;
  const encoder = normalizeEncoderMetadata(input.encoder);
  const timeline = normalizeRecordingCaptureTimeline(input.timeline);

  return {
    sourceId: safeText(input.sourceId, 'recording-source', 120),
    sourceKind,
    sourceLabel: safeText(input.sourceLabel, 'Recording source'),
    mimeType: safeText(input.mimeType, 'application/octet-stream', 120),
    requestedBitsPerSecond,
    startedAt,
    ...(stoppedAt ? { stoppedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    trackCount: Number.isFinite(input.trackCount) ? Math.max(0, Math.floor(Number(input.trackCount))) : tracks.length,
    tracks,
    ...(encoder ? { encoder } : {}),
    ...(timeline ? { timeline } : {}),
  };
}
