import { openTimelineAudioWindowReader, type AudioWindowReader } from './audioWindowReader.ts';
import { CUT_FADE_SECONDS } from './cleanedRenderPlan.ts';
import type { EditSegment } from './editListExport.ts';

export const MIX_SAMPLE_RATE = 48_000;
export const MAX_MIX_TRACKS = 8;
export const MAX_MIX_SECONDS = 10 * 60;
export const MAX_MEMORY_MIX_SECONDS = 90;
export const MIN_MIX_GAIN_DB = -24;
export const MAX_MIX_GAIN_DB = 12;

export interface RecordingTrackMixSetting {
  gainDb: number;
  muted: boolean;
}

export interface RecordingTrackMixSettings {
  pictureId?: string;
  tracks: Record<string, RecordingTrackMixSetting>;
}

export interface RecordingMixSource extends RecordingTrackMixSetting {
  blob: Blob;
  label: string;
  segments: EditSegment[];
}

export interface RecordingMix {
  sources: RecordingMixSource[];
  durationSeconds: number;
}

export function clampMixGain(gainDb: number): number {
  return Number.isFinite(gainDb) ? Math.max(MIN_MIX_GAIN_DB, Math.min(MAX_MIX_GAIN_DB, Math.round(gainDb))) : 0;
}

export function defaultTrackMixSetting(
  track: { id: string; label: string },
  tracks: Array<{ id: string; label: string }>,
): RecordingTrackMixSetting {
  const participant = /^(.*) mic \(lossless\)$/i.exec(track.label)?.[1];
  const hasMatchingTrack = participant != null && tracks.some((other) => other.id !== track.id &&
    other.label.toLowerCase() === `${participant} audio`.toLowerCase());
  return { gainDb: 0, muted: hasMatchingTrack };
}

/** PCM blocks aligned to the edited timeline, independent of camera or input track lengths. */
export async function* mixRecordingAudio(
  mix: RecordingMix,
  signal?: AbortSignal,
): AsyncGenerator<{ data: Float32Array; timestamp: number }> {
  const active = mix.sources.filter((source) => !source.muted && source.segments.length > 0);
  if (active.length > MAX_MIX_TRACKS) throw new Error(`Mix up to ${MAX_MIX_TRACKS} tracks at a time.`);
  if (!Number.isFinite(mix.durationSeconds) || mix.durationSeconds <= 0 || mix.durationSeconds > MAX_MIX_SECONDS) {
    throw new Error('Choose an edited range up to 10 minutes long.');
  }

  const readers: Array<{ source: RecordingMixSource; reader: AudioWindowReader; gain: number; cursor: number }> = [];
  const rate = MIX_SAMPLE_RATE;
  const blockFrames = rate;
  const outputFrames = Math.round(mix.durationSeconds * rate);
  const fadeFrames = Math.round(CUT_FADE_SECONDS * rate);
  try {
    for (const source of active) {
      signal?.throwIfAborted();
      try {
        const reader = await openTimelineAudioWindowReader(source.blob, rate, signal);
        readers.push({ source, reader, gain: 10 ** (clampMixGain(source.gainDb) / 20), cursor: 0 });
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`Could not read ${source.label}. Mute it or choose another track.`, { cause: error });
      }
    }
    for (let startFrame = 0; startFrame < outputFrames; startFrame += blockFrames) {
      signal?.throwIfAborted();
      const endFrame = Math.min(outputFrames, startFrame + blockFrames);
      const block = new Float32Array(endFrame - startFrame);
      for (const channel of readers) {
        signal?.throwIfAborted();
        const { source, reader, gain } = channel;
        for (let index = channel.cursor; index < source.segments.length; index += 1) {
          const segment = source.segments[index];
          const segmentStart = Math.round(segment.recordStart * rate);
          const spanSeconds = Math.min(reader.durationSeconds, segment.sourceEnd) - segment.sourceStart;
          const segmentEnd = segmentStart + Math.round(Math.max(0, spanSeconds) * rate);
          if (segmentEnd <= startFrame) {
            channel.cursor = index + 1;
            continue;
          }
          if (segmentStart >= endFrame) break;
          const first = Math.max(startFrame, segmentStart);
          const end = Math.min(endFrame, segmentEnd);
          if (end <= first) continue;
          const mediaStart = segment.sourceStart + (first - segmentStart) / rate;
          let samples: Float32Array;
          try {
            samples = await reader.readWindow(mediaStart, mediaStart + (end - first) / rate);
          } catch (error) {
            signal?.throwIfAborted();
            throw new Error(`Could not decode ${source.label}. Mute it or choose another track.`, { cause: error });
          }
          const count = Math.min(samples.length, end - first);
          for (let frame = 0; frame < count; frame += 1) {
            const outputFrame = first + frame;
            const fade = Math.min(1, (outputFrame - segmentStart) / fadeFrames, (segmentEnd - outputFrame - 1) / fadeFrames);
            block[outputFrame - startFrame] += samples[frame] * gain * fade;
          }
        }
      }
      for (let frame = 0; frame < block.length; frame += 1) block[frame] = Math.max(-1, Math.min(1, block[frame]));
      yield { data: block, timestamp: startFrame / rate };
    }
  } finally {
    for (const { reader } of readers) reader.close();
  }
}
