/**
 * The in-browser transcript is timed on the track it was made from (the
 * first audio file of the take, normally the host's mic). A clip is cut from
 * whatever file is previewed: the program video, or a guest's ISO track that
 * started later. Burned-in captions and AI highlight timings must be moved
 * onto that file's timeline first, with the same per-track alignment the
 * edit-list export uses, or they drift by the difference in start times.
 */
import { getTrackAlignmentSeconds } from './editListExport.ts';
import { getAlignedTrackStartMs } from './recordingTakeManifest.ts';
import type { TranscriptWord } from './transcriptCleanup.ts';

export interface ClipTranscriptTrack {
  fileName: string;
  label: string;
  kind?: string;
  capture?: unknown;
}

export type ClipTranscriptAlignment =
  | {
      usable: true;
      /** Seconds to add to a transcript time to read the clip file. */
      shiftSeconds: number;
      /** Shown beside the option when the captions are not the clip track's own words. */
      note: string | null;
    }
  | { usable: false; shiftSeconds: 0; note: string };

const SPEAKER_TRACK_KINDS = new Set(['audio', 'iso']);

/**
 * How transcript times map onto the clip's source file. Unusable when the
 * transcribed track is not in the take, or when either file has no capture
 * timing to line the two up with.
 */
export function getClipTranscriptAlignment(
  tracks: ClipTranscriptTrack[],
  transcriptSourceFileName: string | null | undefined,
  clipFile: Pick<ClipTranscriptTrack, 'fileName'> | null | undefined,
): ClipTranscriptAlignment {
  if (!clipFile) return { usable: false, shiftSeconds: 0, note: 'Open a recording file to cut a clip from.' };
  const sourceIndex = transcriptSourceFileName
    ? tracks.findIndex((track) => track.fileName === transcriptSourceFileName)
    : -1;
  if (sourceIndex < 0) {
    return { usable: false, shiftSeconds: 0, note: 'The transcript belongs to a file that is not in this take.' };
  }
  const clipIndex = tracks.findIndex((track) => track.fileName === clipFile.fileName);
  if (clipIndex < 0) {
    return { usable: false, shiftSeconds: 0, note: 'This file is not part of the transcribed take.' };
  }
  if (clipIndex === sourceIndex) return { usable: true, shiftSeconds: 0, note: null };

  const source = tracks[sourceIndex];
  const clip = tracks[clipIndex];
  if (getAlignedTrackStartMs(source.capture) === null || getAlignedTrackStartMs(clip.capture) === null) {
    return {
      usable: false,
      shiftSeconds: 0,
      note: `Captions are timed to ${source.label || source.fileName}, and this file has no capture timing to line them up with.`,
    };
  }
  const shiftSeconds = getTrackAlignmentSeconds(tracks, sourceIndex)[clipIndex] ?? 0;
  // Another person's own track: the words shown are still the transcribed speaker's.
  const otherSpeaker = clip.kind !== undefined && SPEAKER_TRACK_KINDS.has(clip.kind);
  return {
    usable: true,
    shiftSeconds,
    note: otherSpeaker ? `Captions come from the ${source.label || source.fileName} transcript only.` : null,
  };
}

/**
 * Transcript words on the clip file's timeline. Words that fall before the
 * file's first frame are dropped; one that straddles it is trimmed.
 */
export function alignTranscriptWords(words: TranscriptWord[], shiftSeconds: number): TranscriptWord[] {
  if (!shiftSeconds) return words;
  const result: TranscriptWord[] = [];
  for (const word of words) {
    const end = word.end + shiftSeconds;
    if (!(end > 0)) continue;
    result.push({ ...word, start: Math.max(0, word.start + shiftSeconds), end });
  }
  return result;
}
