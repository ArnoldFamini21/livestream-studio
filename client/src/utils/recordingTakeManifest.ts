import {
  normalizeRecordingCaptureMetadata,
  type RecordingCaptureMetadata,
  type RecordingCaptureTimeline,
} from './recordingCaptureMetadata.ts';

/**
 * Track alignment for multi-machine takes.
 *
 * Every recorder stamps its start, stop and pauses with
 * performance.timeOrigin + performance.now(). Guests' clocks are mapped onto
 * the host's clock with an NTP-style offset measured over the transfer data
 * channel. Exports and editor XML then place each track at its real start
 * offset instead of 0:00.
 */

/** Wall-clock milliseconds from the page's monotonic clock. */
export function timelineNow(perf: Pick<Performance, 'now' | 'timeOrigin'> | undefined = typeof performance === 'undefined' ? undefined : performance): number {
  if (perf && Number.isFinite(perf.timeOrigin) && perf.timeOrigin > 0) return perf.timeOrigin + perf.now();
  return Date.now();
}

export function createCaptureTimeline(segmentIndex = 0, startMs = timelineNow()): RecordingCaptureTimeline {
  const timeOrigin = typeof performance !== 'undefined' && performance.timeOrigin > 0 ? performance.timeOrigin : startMs;
  return { startMs, timeOrigin, pauses: [], segmentIndex };
}

export function pauseCaptureTimeline(timeline: RecordingCaptureTimeline, at = timelineNow()): RecordingCaptureTimeline {
  const last = timeline.pauses[timeline.pauses.length - 1];
  if (last && last.endMs === undefined) return timeline;
  return { ...timeline, pauses: [...timeline.pauses, { startMs: at }] };
}

export function resumeCaptureTimeline(timeline: RecordingCaptureTimeline, at = timelineNow()): RecordingCaptureTimeline {
  const last = timeline.pauses[timeline.pauses.length - 1];
  if (!last || last.endMs !== undefined) return timeline;
  return { ...timeline, pauses: [...timeline.pauses.slice(0, -1), { startMs: last.startMs, endMs: Math.max(last.startMs, at) }] };
}

export function stopCaptureTimeline(timeline: RecordingCaptureTimeline, at = timelineNow()): RecordingCaptureTimeline {
  const resumed = resumeCaptureTimeline(timeline, at);
  return { ...resumed, stopMs: at };
}

export interface ClockSample {
  /** Host send time (host clock). */
  t0: number;
  /** Peer receive/reply time (peer clock). */
  t1: number;
  /** Host receive time (host clock). */
  t2: number;
}

export interface ClockOffsetEstimate {
  /** peerClock - hostClock, in ms. Subtract it from peer times to get host times. */
  offsetMs: number;
  rttMs: number;
  samples: number;
}

/**
 * Median offset over the lowest-latency half of the samples (queueing delay
 * only ever makes a sample worse, so the fastest round trips are the most
 * trustworthy).
 */
export function estimateClockOffset(samples: ClockSample[]): ClockOffsetEstimate | null {
  const valid = samples
    .filter((sample) => [sample.t0, sample.t1, sample.t2].every(Number.isFinite) && sample.t2 >= sample.t0)
    .map((sample) => ({ rtt: sample.t2 - sample.t0, offset: sample.t1 - (sample.t0 + sample.t2) / 2 }))
    .sort((a, b) => a.rtt - b.rtt);
  if (!valid.length) return null;
  const best = valid.slice(0, Math.max(1, Math.ceil(valid.length / 2)));
  const offsets = best.map((sample) => sample.offset).sort((a, b) => a - b);
  const middle = Math.floor(offsets.length / 2);
  const offsetMs = offsets.length % 2 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
  return { offsetMs: Math.round(offsetMs * 10) / 10, rttMs: Math.round(best[0].rtt * 10) / 10, samples: valid.length };
}

/** Track start on the host's clock (ms since epoch), or null when unknown. */
export function getAlignedTrackStartMs(capture: unknown): number | null {
  const normalized = normalizeRecordingCaptureMetadata(capture);
  if (!normalized) return null;
  if (normalized.timeline) return normalized.timeline.startMs - (normalized.timeline.clockOffsetMs ?? 0);
  const started = Date.parse(normalized.startedAt);
  return Number.isFinite(started) && started > 0 ? started : null;
}

/**
 * Start offset of every file relative to the earliest track, in seconds.
 * Files without timing stay at 0 (the previous behaviour).
 */
export function getTrackStartOffsetsSeconds(files: Array<{ capture?: unknown }>): number[] {
  const starts = files.map((file) => getAlignedTrackStartMs(file.capture));
  const known = starts.filter((start): start is number => start !== null);
  if (!known.length) return files.map(() => 0);
  const origin = Math.min(...known);
  return starts.map((start) => (start === null ? 0 : Math.max(0, Math.round(start - origin) / 1000)));
}

export interface TakeManifestTrackInput {
  participantId?: string;
  participantName: string;
  label: string;
  kind: string;
  /** Path relative to the recording folder. */
  path: string;
  mimeType: string;
  bytes: number;
  capture?: RecordingCaptureMetadata | unknown;
  /** How the file reached the folder. */
  origin: 'host' | 'program' | 'guest-transfer' | 'browser-fallback';
  status: 'recording' | 'receiving' | 'complete' | 'incomplete';
  /** Lossless WAV of the raw microphone. */
  lossless?: boolean;
}

export interface TakeManifestTrack {
  participantId?: string;
  participantName: string;
  label: string;
  kind: string;
  path: string;
  mimeType: string;
  bytes: number;
  origin: TakeManifestTrackInput['origin'];
  status: TakeManifestTrackInput['status'];
  lossless?: boolean;
  segmentIndex: number;
  /** Where to place the file on the take's timeline. */
  startOffsetMs: number | null;
  /** Recorded media length (pauses excluded). */
  durationMs: number | null;
  /** Gaps in the file, relative to the take start (host clock). */
  pauses: Array<{ startOffsetMs: number; endOffsetMs: number }>;
  clockOffsetMs?: number;
  startedAtWallClock?: string;
}

export interface TakeManifest {
  format: 'livestream-studio-take';
  version: 1;
  takeId: string;
  studioName: string;
  roomId?: string;
  folder: string;
  /** Host wall clock (ms since epoch) at the take start. */
  startedAtMs: number;
  startedAt: string;
  stoppedAt?: string;
  timeOrigin: number;
  alignment: string;
  pauses: Array<{ startOffsetMs: number; endOffsetMs: number }>;
  tracks: TakeManifestTrack[];
  updatedAt: string;
}

export function buildTakeManifest(input: {
  takeId: string;
  studioName: string;
  roomId?: string;
  folder: string;
  startedAtMs: number;
  stoppedAtMs?: number;
  timeOrigin?: number;
  pauses?: Array<{ startMs: number; endMs?: number }>;
  tracks: TakeManifestTrackInput[];
  now?: number;
}): TakeManifest {
  const origin = input.startedAtMs;
  const relative = (ms: number) => Math.round(ms - origin);
  return {
    format: 'livestream-studio-take',
    version: 1,
    takeId: input.takeId,
    studioName: input.studioName,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    folder: input.folder,
    startedAtMs: origin,
    startedAt: new Date(origin).toISOString(),
    ...(input.stoppedAtMs ? { stoppedAt: new Date(input.stoppedAtMs).toISOString() } : {}),
    timeOrigin: input.timeOrigin ?? origin,
    alignment: 'Place each file at startOffsetMs on the take timeline. Guest times are converted to the host clock with a measured clock offset; pauses are gaps with no media in the file.',
    pauses: (input.pauses || []).map((pause) => ({
      startOffsetMs: relative(pause.startMs),
      endOffsetMs: relative(pause.endMs ?? input.stoppedAtMs ?? pause.startMs),
    })),
    tracks: input.tracks.map((track) => {
      const capture = normalizeRecordingCaptureMetadata(track.capture);
      const timeline = capture?.timeline;
      const offset = timeline?.clockOffsetMs ?? 0;
      const start = getAlignedTrackStartMs(capture);
      return {
        ...(track.participantId ? { participantId: track.participantId } : {}),
        participantName: track.participantName,
        label: track.label,
        kind: track.kind,
        path: track.path,
        mimeType: track.mimeType,
        bytes: track.bytes,
        origin: track.origin,
        status: track.status,
        ...(track.lossless ? { lossless: true } : {}),
        segmentIndex: timeline?.segmentIndex ?? 0,
        startOffsetMs: start === null ? null : relative(start),
        durationMs: capture?.durationMs ?? null,
        pauses: (timeline?.pauses || []).map((pause) => ({
          startOffsetMs: relative(pause.startMs - offset),
          endOffsetMs: relative((pause.endMs ?? timeline?.stopMs ?? pause.startMs) - offset),
        })),
        ...(timeline?.clockOffsetMs !== undefined ? { clockOffsetMs: timeline.clockOffsetMs } : {}),
        ...(capture?.startedAt ? { startedAtWallClock: capture.startedAt } : {}),
      };
    }),
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}

/** Express a peer's capture on the host clock by recording the measured offset. */
export function withClockOffset<T extends { timeline?: RecordingCaptureTimeline }>(capture: T, offsetMs: number | null | undefined): T {
  if (!capture.timeline || offsetMs === null || offsetMs === undefined || !Number.isFinite(offsetMs)) return capture;
  return { ...capture, timeline: { ...capture.timeline, clockOffsetMs: offsetMs } };
}
