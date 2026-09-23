/**
 * Transcript-based cleanup: find filler words, stutters, and long pauses in a
 * word-timed transcript and turn them into a cut list. The cut list drives a
 * skip-the-cuts preview, a local cleaned-audio render, and the media server's
 * multi-range export, so every output removes exactly the same moments.
 */

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export type CleanupReason = 'filler' | 'repeat' | 'manual' | 'pause';

export interface CleanupCut {
  /** Stable id used to restore a cut: `word:<index>` or `pause:<prev>-<next>`. */
  id: string;
  start: number;
  end: number;
  reason: CleanupReason;
}

export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

export interface CleanupOptions {
  removeFillers: boolean;
  removeRepeats: boolean;
  shortenPauses: boolean;
  /** Gaps longer than this are shortened. */
  pauseThresholdSeconds: number;
  /** How much of a shortened gap is kept, so speech never sounds clipped. */
  keepPauseSeconds: number;
  /** Cut ids the user chose to keep anyway. */
  restored: ReadonlySet<string>;
  /** Word indexes the user struck out by hand. */
  manualWords: ReadonlySet<number>;
}

export interface CleanupWordState {
  index: number;
  word: string;
  start: number;
  end: number;
  reason: Exclude<CleanupReason, 'pause'> | null;
  removed: boolean;
}

export interface CleanupPlan {
  words: CleanupWordState[];
  cuts: CleanupCut[];
  keepRanges: TimeRange[];
  durationSeconds: number;
  removedSeconds: number;
  counts: { filler: number; repeat: number; manual: number; pause: number };
  /** More kept ranges than an export accepts; turn off a cleanup type or restore cuts. */
  tooManyCuts: boolean;
}

export const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  removeFillers: true,
  removeRepeats: true,
  shortenPauses: true,
  pauseThresholdSeconds: 1,
  keepPauseSeconds: 0.4,
  restored: new Set(),
  manualWords: new Set(),
};

/** Single-token disfluencies. Words like "like" or "so" carry meaning too often to cut automatically. */
const FILLER_WORDS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'uhmm', 'erm', 'er', 'err', 'ah', 'ahh', 'hmm', 'hmmm', 'hm', 'mm', 'mmm',
]);
/** Cut edges stay this far from neighbouring words so no syllable is clipped. */
const EDGE_GUARD_SECONDS = 0.03;
/** Kept slivers shorter than this are absorbed into the surrounding cuts. */
const MIN_KEEP_SECONDS = 0.06;
export const MAX_KEEP_RANGES = 2000;

export function normalizeCleanupToken(word: string): string {
  return word.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}']/gu, '');
}

export function isFillerWord(word: string): boolean {
  return FILLER_WORDS.has(normalizeCleanupToken(word));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Stutters: the same word said twice in a row ("I I think"), cutting the first. */
function isRepeatOfNext(words: TranscriptWord[], index: number): boolean {
  const current = normalizeCleanupToken(words[index].word);
  const next = words[index + 1] ? normalizeCleanupToken(words[index + 1].word) : '';
  if (!current || current !== next) return false;
  // Allow deliberate emphasis ("very, very"): a comma after the first word means it was intended.
  if (/[,;:]$/.test(words[index].word.trim())) return false;
  return words[index + 1].start - words[index].end < 0.6;
}

function mergeCuts(cuts: CleanupCut[]): CleanupCut[] {
  const sorted = cuts
    .filter((cut) => cut.end - cut.start > 0.001)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CleanupCut[] = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end + MIN_KEEP_SECONDS) {
      if (cut.end > last.end) last.end = cut.end;
      continue;
    }
    merged.push({ ...cut });
  }
  return merged;
}

/** The complement of the cuts within [0, duration], dropping slivers. */
export function getKeepRanges(cuts: CleanupCut[], durationSeconds: number): TimeRange[] {
  const keep: TimeRange[] = [];
  let cursor = 0;
  for (const cut of mergeCuts(cuts)) {
    if (cut.start - cursor >= MIN_KEEP_SECONDS) keep.push({ startSeconds: round(cursor), endSeconds: round(cut.start) });
    cursor = Math.max(cursor, cut.end);
  }
  if (durationSeconds - cursor >= MIN_KEEP_SECONDS) keep.push({ startSeconds: round(cursor), endSeconds: round(durationSeconds) });
  return keep;
}

export function buildCleanupPlan(
  transcriptWords: TranscriptWord[],
  durationSeconds: number,
  options: CleanupOptions = DEFAULT_CLEANUP_OPTIONS
): CleanupPlan {
  const lastWordEnd = transcriptWords.length ? transcriptWords[transcriptWords.length - 1].end : 0;
  const duration = Math.max(Number.isFinite(durationSeconds) ? durationSeconds : 0, lastWordEnd);

  const words: CleanupWordState[] = transcriptWords.map((word, index) => {
    let reason: CleanupWordState['reason'] = null;
    if (options.manualWords.has(index)) reason = 'manual';
    else if (options.removeFillers && isFillerWord(word.word)) reason = 'filler';
    else if (options.removeRepeats && isRepeatOfNext(transcriptWords, index)) reason = 'repeat';
    const removed = reason !== null && !options.restored.has(`word:${index}`);
    return { index, word: word.word, start: word.start, end: word.end, reason, removed };
  });

  const cuts: CleanupCut[] = [];
  const counts = { filler: 0, repeat: 0, manual: 0, pause: 0 };
  const kept = words.filter((word) => !word.removed);

  // Walk each gap between kept words (plus the lead-in and tail); a gap holds
  // any removed words that sat between them.
  for (let k = 0; k <= kept.length; k += 1) {
    const prev = kept[k - 1];
    const next = kept[k];
    const gapStart = prev ? prev.end : 0;
    const gapEnd = next ? next.start : duration;
    if (gapEnd <= gapStart) continue;
    const inside = words.filter((word) => word.removed && word.start >= gapStart - 0.001 && word.end <= gapEnd + 0.001);
    const pauseId = `pause:${prev ? prev.index : 'start'}-${next ? next.index : 'end'}`;
    const keepHalf = options.keepPauseSeconds / 2;

    if (options.shortenPauses && gapEnd - gapStart > options.pauseThresholdSeconds && !options.restored.has(pauseId)) {
      // Keep a natural beat on each side (none at the very start or end).
      const start = prev ? gapStart + keepHalf : 0;
      const end = next ? gapEnd - keepHalf : duration;
      if (end - start > 0.05) {
        cuts.push({ id: pauseId, start: round(start), end: round(end), reason: 'pause' });
        counts.pause += 1;
        for (const word of inside) counts[word.reason as 'filler' | 'repeat' | 'manual'] += 1;
        continue;
      }
    }

    for (const word of inside) {
      const start = Math.max(gapStart + (prev ? EDGE_GUARD_SECONDS : 0), word.start - 0.02);
      const end = Math.min(gapEnd - (next ? EDGE_GUARD_SECONDS : 0), word.end + 0.02);
      if (end <= start) continue;
      cuts.push({ id: `word:${word.index}`, start: round(start), end: round(end), reason: word.reason as CleanupReason });
      counts[word.reason as 'filler' | 'repeat' | 'manual'] += 1;
    }
  }

  const merged = mergeCuts(cuts);
  const keepRanges = getKeepRanges(merged, duration);
  const keptSeconds = keepRanges.reduce((total, range) => total + (range.endSeconds - range.startSeconds), 0);

  return {
    words,
    cuts: cuts.sort((a, b) => a.start - b.start),
    keepRanges,
    durationSeconds: round(duration),
    removedSeconds: round(Math.max(0, duration - keptSeconds)),
    counts,
    tooManyCuts: keepRanges.length > MAX_KEEP_RANGES,
  };
}

/**
 * Where playback should continue from when `seconds` falls inside a cut:
 * the next kept range's start, `Infinity` past the last kept range, or
 * `null` when `seconds` is already inside kept media.
 */
export function skipCutAt(keepRanges: TimeRange[], seconds: number): number | null {
  for (const range of keepRanges) {
    if (seconds < range.startSeconds - 0.02) return range.startSeconds;
    if (seconds < range.endSeconds) return null;
  }
  return keepRanges.length ? Number.POSITIVE_INFINITY : null;
}

/** Map a time in the original recording to the cleaned timeline. */
export function toCleanedTime(keepRanges: TimeRange[], seconds: number): number {
  let cleaned = 0;
  for (const range of keepRanges) {
    if (seconds <= range.startSeconds) break;
    cleaned += Math.min(seconds, range.endSeconds) - range.startSeconds;
    if (seconds < range.endSeconds) break;
  }
  return round(cleaned);
}

export function buildCleanedTranscriptText(plan: CleanupPlan): string {
  return plan.words
    .filter((word) => !word.removed)
    .map((word) => word.word)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

export function formatRemovedTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Splice the kept ranges out of decoded audio with short fades at every join,
 * so cuts never click. Returns per-channel samples ready for WAV encoding.
 */
export function spliceAudioChannels(
  channels: Float32Array[],
  sampleRate: number,
  keepRanges: TimeRange[],
  fadeSeconds = 0.008
): Float32Array[] {
  const frames = channels[0]?.length || 0;
  const segments = keepRanges
    .map((range) => ({
      from: Math.max(0, Math.min(frames, Math.round(range.startSeconds * sampleRate))),
      to: Math.max(0, Math.min(frames, Math.round(range.endSeconds * sampleRate))),
    }))
    .filter((segment) => segment.to > segment.from);
  const total = segments.reduce((sum, segment) => sum + segment.to - segment.from, 0);
  const fade = Math.max(1, Math.round(fadeSeconds * sampleRate));

  return channels.map((source) => {
    const output = new Float32Array(total);
    let offset = 0;
    segments.forEach((segment, index) => {
      const length = segment.to - segment.from;
      output.set(source.subarray(segment.from, segment.to), offset);
      const ramp = Math.min(fade, Math.floor(length / 2));
      // Fade in after a join and out before the next one; the recording's own
      // start and end are left untouched.
      if (index > 0 || segment.from > 0) {
        for (let i = 0; i < ramp; i += 1) output[offset + i] *= i / ramp;
      }
      if (index < segments.length - 1 || segment.to < frames) {
        for (let i = 0; i < ramp; i += 1) output[offset + length - 1 - i] *= i / ramp;
      }
      offset += length;
    });
    return output;
  });
}
