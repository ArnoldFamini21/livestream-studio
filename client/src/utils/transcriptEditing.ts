import { buildClipCaptionCues, type ClipCaptionCue } from './clipCaptions.ts';
import type { EditListWord } from './editListExport.ts';
import type { RecordingTranscriptionResult } from './recordingTranscription.ts';
import type { RecordingTrackMixSettings } from './recordingTrackMix.ts';
import { DEFAULT_CLEANUP_OPTIONS, type CleanupWordState, type TimeRange } from './transcriptCleanup.ts';

export interface TranscriptEditDraft {
  removeFillers: boolean;
  removeRepeats: boolean;
  shortenPauses: boolean;
  pauseThreshold: number;
  restored: string[];
  manualWords: number[];
  excerpt: TimeRange | null;
}

export interface RecordingTranscriptProject {
  sourceId: string;
  sourceSize: number;
  transcript: RecordingTranscriptionResult;
  edit: TranscriptEditDraft;
  mix?: RecordingTrackMixSettings;
}

export function createTranscriptEditDraft(automatic: boolean): TranscriptEditDraft {
  return {
    removeFillers: automatic,
    removeRepeats: automatic,
    shortenPauses: automatic,
    pauseThreshold: DEFAULT_CLEANUP_OPTIONS.pauseThresholdSeconds,
    restored: [],
    manualWords: [],
    excerpt: null,
  };
}

export function editTranscriptWordRange(
  draft: TranscriptEditDraft,
  words: CleanupWordState[],
  indexes: [number, number],
  cut: boolean,
): TranscriptEditDraft {
  const manual = new Set(draft.manualWords);
  const restored = new Set(draft.restored);
  for (const word of words.slice(Math.min(...indexes), Math.max(...indexes) + 1)) {
    const id = 'word:' + word.index;
    if (cut) {
      restored.delete(id);
      manual.add(word.index);
    } else {
      manual.delete(word.index);
      restored.add(id);
    }
  }
  return { ...draft, restored: [...restored], manualWords: [...manual] };
}

export function limitTranscriptKeepRanges(ranges: TimeRange[], excerpt: TimeRange | null): TimeRange[] {
  if (!excerpt) return ranges;
  return ranges.flatMap((range) => {
    const startSeconds = Math.max(range.startSeconds, excerpt.startSeconds);
    const endSeconds = Math.min(range.endSeconds, excerpt.endSeconds);
    return endSeconds > startSeconds ? [{ startSeconds, endSeconds }] : [];
  });
}

/** Map once to the edited timeline so burn-in and media frame times share the same clock. */
export function buildEditedClipCaptions(words: EditListWord[], ranges: TimeRange[]): ClipCaptionCue[] {
  const mapped = [];
  let rangeIndex = 0;
  let outputStart = 0;
  for (const word of words) {
    if (word.removed) continue;
    const midpoint = (word.start + word.end) / 2;
    while (rangeIndex < ranges.length && midpoint >= ranges[rangeIndex].endSeconds) {
      const range = ranges[rangeIndex++];
      outputStart += range.endSeconds - range.startSeconds;
    }
    const range = ranges[rangeIndex];
    if (!range) break;
    if (midpoint < range.startSeconds) continue;
    mapped.push({
      word: word.word,
      start: outputStart + Math.max(word.start, range.startSeconds) - range.startSeconds,
      end: outputStart + Math.min(word.end, range.endSeconds) - range.startSeconds,
    });
  }
  return buildClipCaptionCues(mapped, {
    startSeconds: 0,
    endSeconds: ranges.reduce((total, range) => total + range.endSeconds - range.startSeconds, 0),
  });
}
