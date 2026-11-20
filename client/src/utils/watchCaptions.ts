import type { WatchCaptionCue } from '@studio/shared';

/** Safari exposes the wall-clock start of native HLS if program dates are present. */
export function readWatchPlaybackTime(video: HTMLVideoElement | null, hlsDate: Date | null | undefined): number | null {
  if (!video || video.readyState < 2) return null;
  const scriptedTime = hlsDate?.getTime();
  if (typeof scriptedTime === 'number' && Number.isFinite(scriptedTime)) return scriptedTime;
  const native = video as HTMLVideoElement & { getStartDate?: () => Date };
  const nativeStart = native.getStartDate?.()?.getTime();
  return typeof nativeStart === 'number' && Number.isFinite(nativeStart) && Number.isFinite(video.currentTime)
    ? nativeStart + video.currentTime * 1000
    : null;
}

export function selectWatchCaption(cues: readonly WatchCaptionCue[], mediaTimeMs: number | null): WatchCaptionCue | null {
  if (mediaTimeMs === null || !Number.isFinite(mediaTimeMs)) return null;
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    const cue = cues[index];
    if (cue.startMs <= mediaTimeMs && mediaTimeMs < cue.endMs) return cue;
  }
  return null;
}
