/**
 * Local recording bitrate that scales with the captured resolution and frame
 * rate, so a 4K camera is not squeezed into a 1080p budget and a 720p webcam
 * does not waste disk.
 *
 *   720p30  ->  5 Mbps     1080p30 -> 10 Mbps
 *   1440p30 -> 20 Mbps     2160p30 -> 40 Mbps
 *
 * Higher frame rates add up to 50% (60 fps), lower ones save down to 60%.
 */

const TIERS: Array<{ pixels: number; bitsPerSecond: number }> = [
  { pixels: 640 * 360, bitsPerSecond: 2_000_000 },
  { pixels: 854 * 480, bitsPerSecond: 3_000_000 },
  { pixels: 1280 * 720, bitsPerSecond: 5_000_000 },
  { pixels: 1920 * 1080, bitsPerSecond: 10_000_000 },
  { pixels: 2560 * 1440, bitsPerSecond: 20_000_000 },
  { pixels: 3840 * 2160, bitsPerSecond: 40_000_000 },
];

export const MIN_RECORDING_VIDEO_BITS_PER_SECOND = 1_500_000;
export const MAX_RECORDING_VIDEO_BITS_PER_SECOND = 45_000_000;
export const DEFAULT_RECORDING_VIDEO_BITS_PER_SECOND = 10_000_000;

export function getRecordingVideoBitsPerSecond(settings: { width?: number; height?: number; frameRate?: number } | null | undefined): number {
  const width = Number(settings?.width);
  const height = Number(settings?.height);
  if (!(width > 0) || !(height > 0)) return DEFAULT_RECORDING_VIDEO_BITS_PER_SECOND;
  const pixels = width * height;
  let base: number;
  if (pixels <= TIERS[0].pixels) {
    base = TIERS[0].bitsPerSecond * (pixels / TIERS[0].pixels);
  } else if (pixels >= TIERS[TIERS.length - 1].pixels) {
    base = TIERS[TIERS.length - 1].bitsPerSecond * (pixels / TIERS[TIERS.length - 1].pixels);
  } else {
    const upper = TIERS.findIndex((tier) => tier.pixels >= pixels);
    const low = TIERS[upper - 1];
    const high = TIERS[upper];
    const ratio = (pixels - low.pixels) / (high.pixels - low.pixels);
    base = low.bitsPerSecond + ratio * (high.bitsPerSecond - low.bitsPerSecond);
  }
  const frameRate = Number(settings?.frameRate);
  const fpsFactor = frameRate > 0 ? Math.max(0.6, Math.min(1.5, 1 + (frameRate - 30) / 60)) : 1;
  const bitsPerSecond = Math.round((base * fpsFactor) / 100_000) * 100_000;
  return Math.max(MIN_RECORDING_VIDEO_BITS_PER_SECOND, Math.min(MAX_RECORDING_VIDEO_BITS_PER_SECOND, bitsPerSecond));
}

/** Bitrate for the first live video track of a stream. */
export function getStreamRecordingVideoBitsPerSecond(stream: MediaStream): number {
  const track = stream.getVideoTracks().find((candidate) => candidate.readyState === 'live');
  let settings: MediaTrackSettings | undefined;
  try { settings = track?.getSettings?.(); } catch { settings = undefined; }
  return getRecordingVideoBitsPerSecond(settings);
}

/** Planned recording rate for a set of sources, for the storage preflight. */
export function estimateRecordingBitsPerSecond(sources: Array<{ kind: string; stream: MediaStream; bitsPerSecond?: number }>): number {
  return sources.reduce((sum, source) => {
    if (source.bitsPerSecond) return sum + source.bitsPerSecond;
    const hasVideo = source.stream.getVideoTracks().some((track) => track.readyState === 'live');
    return sum + (hasVideo ? getStreamRecordingVideoBitsPerSecond(source.stream) + 256_000 : 256_000);
  }, 0);
}
