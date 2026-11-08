import type { EditSegment } from './editListExport.ts';

/**
 * Pure planning for the in-browser cleaned render (see cleanedRender.ts):
 * which decoded frames and audio frames survive the cuts, where they land on
 * the cleaned timeline, and whether this browser can do it at all.
 */

export interface BrowserRenderSupport {
  supported: boolean;
  /** Why not, in words the host can act on. */
  reason?: string;
}

/** WebCodecs decode + encode for video and audio is what the render needs. */
export function getBrowserRenderSupport(scope: unknown = globalThis): BrowserRenderSupport {
  const api = scope as Record<string, unknown>;
  const missing = ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder'].filter((name) => typeof api[name] !== 'function');
  if (missing.length === 0) return { supported: true };
  const videoMissing = missing.includes('VideoDecoder') || missing.includes('VideoEncoder');
  return {
    supported: false,
    reason: videoMissing
      ? 'This browser cannot encode video itself (WebCodecs is missing, e.g. Safari before 17 or an old Firefox). Use Chrome or Edge, export the edit list for DaVinci Resolve, or use the media server export.'
      : 'This browser cannot encode audio itself (WebCodecs audio is missing, e.g. Safari before 26). Use Chrome or Edge, export the edit list for DaVinci Resolve, or use the media server export.',
  };
}

/**
 * Maps media times of one track (seconds from its first frame) onto the
 * cleaned timeline. Calls must come in non-decreasing time order (decode
 * order of a whole file), which keeps every lookup O(1) amortized.
 */
export class KeepRangeMapper {
  private index = 0;

  constructor(private readonly segments: readonly EditSegment[]) {}

  /** The cleaned-timeline time of a frame shown at `seconds`, or null when it is cut. */
  map(seconds: number): number | null {
    while (this.index < this.segments.length && seconds >= this.segments[this.index].sourceEnd) this.index += 1;
    const segment = this.segments[this.index];
    if (!segment || seconds < segment.sourceStart) return null;
    return segment.recordStart + (seconds - segment.sourceStart);
  }

  /** Nothing after this time is kept. */
  get done(): boolean {
    return this.index >= this.segments.length;
  }
}

export interface AudioSpan {
  /** First frame to keep, inclusive. */
  startFrame: number;
  /** Frame after the last one to keep. */
  endFrame: number;
  /** Where the first kept frame lands on the cleaned timeline (seconds). */
  outputTimestamp: number;
  /** The span begins right after a cut and should fade in. */
  fadeIn: boolean;
  /** The span ends right before a cut and should fade out. */
  fadeOut: boolean;
}

/**
 * The kept parts of one decoded audio block [timestamp, timestamp + frames /
 * sampleRate). A block that straddles a cut becomes several spans; frame
 * edges are rounded so consecutive blocks never overlap or leave gaps.
 */
export function splitAudioBlock(
  segments: readonly EditSegment[],
  timestamp: number,
  numberOfFrames: number,
  sampleRate: number,
): AudioSpan[] {
  const spans: AudioSpan[] = [];
  if (numberOfFrames <= 0 || sampleRate <= 0) return spans;
  const blockEnd = timestamp + numberOfFrames / sampleRate;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.sourceEnd <= timestamp) continue;
    if (segment.sourceStart >= blockEnd) break;
    const startFrame = Math.max(0, Math.round((segment.sourceStart - timestamp) * sampleRate));
    const endFrame = Math.min(numberOfFrames, Math.round((segment.sourceEnd - timestamp) * sampleRate));
    if (endFrame <= startFrame) continue;
    const startSeconds = timestamp + startFrame / sampleRate;
    spans.push({
      startFrame,
      endFrame,
      outputTimestamp: Math.round((segment.recordStart + (startSeconds - segment.sourceStart)) * 1e6) / 1e6,
      // Every segment edge is a cut, except the take's own start and the last segment's end.
      fadeIn: segment.sourceStart >= timestamp && (index > 0 || segment.sourceStart > 0),
      fadeOut: segment.sourceEnd <= blockEnd && index < segments.length - 1,
    });
  }
  return spans;
}

/** Short linear fades at a join so a cut never clicks (5 ms at 48 kHz). */
export const CUT_FADE_SECONDS = 0.005;

export function applyEdgeFades(planes: Float32Array[], sampleRate: number, fadeIn: boolean, fadeOut: boolean): void {
  const frames = planes[0]?.length || 0;
  const fadeFrames = Math.min(Math.floor(frames / 2), Math.max(1, Math.round(CUT_FADE_SECONDS * sampleRate)));
  if (fadeFrames <= 0) return;
  for (const plane of planes) {
    if (fadeIn) for (let frame = 0; frame < fadeFrames; frame += 1) plane[frame] *= frame / fadeFrames;
    if (fadeOut) for (let frame = 0; frame < fadeFrames; frame += 1) plane[frames - 1 - frame] *= frame / fadeFrames;
  }
}

/** A bitrate that keeps cleaned exports close to the source quality: ~8 Mbps for 1080p30. */
export function chooseRenderVideoBitrate(width: number, height: number, frameRate = 30): number {
  const pixels = Math.max(1, width) * Math.max(1, height);
  const bitsPerPixelFrame = 0.13;
  const bitrate = pixels * Math.max(15, Math.min(60, frameRate)) * bitsPerPixelFrame;
  return Math.round(Math.min(20_000_000, Math.max(1_500_000, bitrate)) / 100_000) * 100_000;
}

/** H.264 needs even dimensions. */
export function toEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function buildRenderFileName(baseName: string, trackLabel: string, extension: 'mp4' | 'm4a'): string {
  const safe = (value: string) => value.normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return `${safe(baseName) || 'recording'}_${safe(trackLabel) || 'track'}_cleaned.${extension}`;
}

export interface RenderProgress {
  /** 0..1 */
  fraction: number;
  /** Cleaned seconds written so far. */
  renderedSeconds: number;
  totalSeconds: number;
}

export function computeRenderProgress(outputSeconds: number, totalSeconds: number): RenderProgress {
  const total = Math.max(0.001, totalSeconds);
  const rendered = Math.max(0, Math.min(total, outputSeconds));
  return { fraction: rendered / total, renderedSeconds: rendered, totalSeconds: total };
}
