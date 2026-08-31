import type { TranscriptTimedText } from './recordingTranscription.ts';

/**
 * Transcript-driven editing: the recording is cut by deleting words from its
 * transcript rather than by dragging a timeline. Every edit resolves to an EDL
 * (a list of kept source ranges) that both the browser exporter and the
 * media-server FFmpeg exporter can render.
 */

export interface TranscriptWordToken {
  id: string;
  index: number;
  /** Word text as spoken, punctuation included. */
  text: string;
  /** Lowercased, punctuation-stripped form used for filler matching. */
  normalized: string;
  startSeconds: number;
  endSeconds: number;
  /** Silence between the previous word's end and this word's start. */
  gapBeforeSeconds: number;
}

export interface TranscriptSilenceGap {
  id: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** Index of the word that follows the gap; equals word count for a trailing gap. */
  beforeWordIndex: number;
}

export interface TranscriptFillerRun {
  id: string;
  wordIds: string[];
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface TranscriptEditorDocument {
  words: TranscriptWordToken[];
  durationSeconds: number;
}

export interface TranscriptEditSelection {
  removedWordIds?: readonly string[];
  trimmedGapIds?: readonly string[];
}

export interface TranscriptEdlSegment {
  startSeconds: number;
  endSeconds: number;
}

export interface TranscriptEdl {
  segments: TranscriptEdlSegment[];
  sourceDurationSeconds: number;
  keptSeconds: number;
  removedSeconds: number;
}

export interface TranscriptEdlOptions {
  /**
   * Keeps a sliver of the neighbouring words' onset and tail so cuts do not
   * clip consonants when the word boundaries are tight.
   */
  padSeconds?: number;
  /** Cuts closer together than this are merged into one cut. */
  mergeCutGapSeconds?: number;
  /**
   * Kept slivers shorter than this are cut too — but only when no surviving
   * word sits inside them, so a short word is never dropped by the backstop.
   */
  minSegmentSeconds?: number;
  /** Residual pause left behind when a silence gap is trimmed. */
  silenceKeepSeconds?: number;
}

export interface TranscriptFillerOptions {
  /** Multi-word crutches such as "you know" and "i mean". */
  includePhrases?: boolean;
  /**
   * Discourse markers such as "like" and "basically". These are real words in
   * plenty of sentences, so they are opt-in and worth reviewing before export.
   */
  includeHedges?: boolean;
}

export interface TranscriptEditSummary {
  removedWordCount: number;
  trimmedSilenceCount: number;
  removedSeconds: number;
  keptSeconds: number;
  sourceDurationSeconds: number;
  /** Share of the source duration removed, 0-1. */
  tightenedFraction: number;
  segmentCount: number;
}

export const DEFAULT_SILENCE_THRESHOLD_SECONDS = 0.75;
export const DEFAULT_SILENCE_KEEP_SECONDS = 0.25;
export const DEFAULT_CUT_PAD_SECONDS = 0.04;
export const DEFAULT_MERGE_CUT_GAP_SECONDS = 0.12;
export const DEFAULT_MIN_SEGMENT_SECONDS = 0.35;
export const MAX_EDL_SEGMENTS = 400;

const FILLER_WORDS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'erm', 'er', 'ah', 'ahh',
  'eh', 'hm', 'hmm', 'hmmm', 'mhm', 'mm', 'mmm',
]);

const HEDGE_WORDS = new Set([
  'like', 'basically', 'actually', 'literally', 'honestly', 'obviously', 'right',
]);

const FILLER_PHRASES: readonly string[][] = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
];

export function normalizeTranscriptWordText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '');
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Builds the editable document from word timings. Words are sorted and
 * de-overlapped so downstream cut maths always sees a monotonic timeline.
 */
export function buildTranscriptEditorDocument(
  words: readonly TranscriptTimedText[],
  durationSeconds?: number
): TranscriptEditorDocument {
  const usable = words
    .filter((word) => (
      typeof word.text === 'string'
      && word.text.trim().length > 0
      && Number.isFinite(word.startSeconds)
      && Number.isFinite(word.endSeconds)
      && word.startSeconds >= 0
      && word.endSeconds >= word.startSeconds
    ))
    .slice()
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);

  const tokens: TranscriptWordToken[] = [];
  let previousEnd = 0;
  usable.forEach((word) => {
    const startSeconds = roundSeconds(Math.max(word.startSeconds, previousEnd));
    const endSeconds = roundSeconds(Math.max(word.endSeconds, startSeconds));
    const index = tokens.length;
    tokens.push({
      id: `w${index}`,
      index,
      text: word.text.trim(),
      normalized: normalizeTranscriptWordText(word.text),
      startSeconds,
      endSeconds,
      gapBeforeSeconds: roundSeconds(Math.max(0, startSeconds - previousEnd)),
    });
    previousEnd = endSeconds;
  });

  const lastEnd = tokens.length > 0 ? tokens[tokens.length - 1].endSeconds : 0;
  const resolvedDuration = Number.isFinite(durationSeconds) && (durationSeconds as number) > lastEnd
    ? roundSeconds(durationSeconds as number)
    : lastEnd;

  return { words: tokens, durationSeconds: resolvedDuration };
}

export function findTranscriptSilenceGaps(
  doc: TranscriptEditorDocument,
  minSilenceSeconds = DEFAULT_SILENCE_THRESHOLD_SECONDS
): TranscriptSilenceGap[] {
  const threshold = Number.isFinite(minSilenceSeconds) && minSilenceSeconds > 0
    ? minSilenceSeconds
    : DEFAULT_SILENCE_THRESHOLD_SECONDS;
  const gaps: TranscriptSilenceGap[] = [];

  doc.words.forEach((word) => {
    if (word.gapBeforeSeconds < threshold) return;
    gaps.push({
      id: `g${word.index}`,
      startSeconds: roundSeconds(word.startSeconds - word.gapBeforeSeconds),
      endSeconds: word.startSeconds,
      durationSeconds: word.gapBeforeSeconds,
      beforeWordIndex: word.index,
    });
  });

  const lastWord = doc.words[doc.words.length - 1];
  const trailing = lastWord ? roundSeconds(doc.durationSeconds - lastWord.endSeconds) : 0;
  if (lastWord && trailing >= threshold) {
    gaps.push({
      id: `g${doc.words.length}`,
      startSeconds: lastWord.endSeconds,
      endSeconds: doc.durationSeconds,
      durationSeconds: trailing,
      beforeWordIndex: doc.words.length,
    });
  }

  return gaps;
}

function isFillerWord(normalized: string, options: TranscriptFillerOptions): boolean {
  if (FILLER_WORDS.has(normalized)) return true;
  return options.includeHedges === true && HEDGE_WORDS.has(normalized);
}

function matchesPhraseAt(doc: TranscriptEditorDocument, index: number, phrase: readonly string[]): boolean {
  return phrase.every((part, offset) => doc.words[index + offset]?.normalized === part);
}

/**
 * Groups filler words into runs so "um, uh" removes as a single cut rather
 * than two cuts separated by an unusable sliver.
 */
export function findTranscriptFillerRuns(
  doc: TranscriptEditorDocument,
  options: TranscriptFillerOptions = {}
): TranscriptFillerRun[] {
  const runs: TranscriptFillerRun[] = [];
  let current: TranscriptWordToken[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    runs.push({
      id: `f${first.index}`,
      wordIds: current.map((word) => word.id),
      text: current.map((word) => word.text).join(' '),
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
    });
    current = [];
  };

  for (let index = 0; index < doc.words.length; index += 1) {
    const word = doc.words[index];
    const phrase = options.includePhrases === true
      ? FILLER_PHRASES.find((candidate) => matchesPhraseAt(doc, index, candidate))
      : undefined;

    if (phrase) {
      for (let offset = 0; offset < phrase.length; offset += 1) {
        current.push(doc.words[index + offset]);
      }
      index += phrase.length - 1;
      continue;
    }

    if (isFillerWord(word.normalized, options)) {
      current.push(word);
      continue;
    }

    flush();
  }
  flush();

  return runs;
}

interface CutInterval {
  startSeconds: number;
  endSeconds: number;
}

function mergeIntervals(intervals: CutInterval[], mergeGapSeconds: number): CutInterval[] {
  const sorted = intervals
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: CutInterval[] = [];

  sorted.forEach((interval) => {
    const previous = merged[merged.length - 1];
    if (previous && interval.startSeconds - previous.endSeconds <= mergeGapSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, interval.endSeconds);
      return;
    }
    merged.push({ ...interval });
  });

  return merged;
}

/**
 * Resolves a word/silence selection into the source ranges that survive the
 * edit. Cuts are padded inward, merged, and any kept sliver too short to be
 * watchable is folded into the surrounding cut.
 */
export function buildTranscriptEdl(
  doc: TranscriptEditorDocument,
  selection: TranscriptEditSelection = {},
  options: TranscriptEdlOptions = {}
): TranscriptEdl {
  const padSeconds = Math.max(0, options.padSeconds ?? DEFAULT_CUT_PAD_SECONDS);
  const mergeCutGapSeconds = Math.max(0, options.mergeCutGapSeconds ?? DEFAULT_MERGE_CUT_GAP_SECONDS);
  const minSegmentSeconds = Math.max(0, options.minSegmentSeconds ?? DEFAULT_MIN_SEGMENT_SECONDS);
  const silenceKeepSeconds = Math.max(0, options.silenceKeepSeconds ?? DEFAULT_SILENCE_KEEP_SECONDS);
  const sourceDurationSeconds = Math.max(0, doc.durationSeconds);

  if (sourceDurationSeconds <= 0) {
    return { segments: [], sourceDurationSeconds: 0, keptSeconds: 0, removedSeconds: 0 };
  }

  const removedWordIds = new Set(selection.removedWordIds || []);
  const trimmedGapIds = new Set(selection.trimmedGapIds || []);
  const cuts: CutInterval[] = [];

  doc.words.forEach((word) => {
    if (!removedWordIds.has(word.id)) return;
    cuts.push({
      startSeconds: word.startSeconds + padSeconds,
      endSeconds: word.endSeconds - padSeconds,
    });
  });

  if (trimmedGapIds.size > 0) {
    findTranscriptSilenceGaps(doc, 0.001).forEach((gap) => {
      if (!trimmedGapIds.has(gap.id)) return;
      const keep = Math.min(silenceKeepSeconds, gap.durationSeconds);
      const edge = keep / 2;
      cuts.push({
        startSeconds: gap.startSeconds + edge,
        endSeconds: gap.endSeconds - edge,
      });
    });
  }

  const mergedCuts = boundCutCount(mergeIntervals(cuts, mergeCutGapSeconds));
  const survivingMidpoints = doc.words
    .filter((word) => !removedWordIds.has(word.id))
    .map((word) => (word.startSeconds + word.endSeconds) / 2);

  const segments: TranscriptEdlSegment[] = [];
  let cursor = 0;

  const pushSegment = (startSeconds: number, endSeconds: number) => {
    if (endSeconds <= startSeconds) return;
    if (endSeconds - startSeconds < minSegmentSeconds) {
      const holdsWord = survivingMidpoints.some((midpoint) => midpoint >= startSeconds && midpoint <= endSeconds);
      if (!holdsWord) return;
    }
    segments.push({ startSeconds: roundSeconds(startSeconds), endSeconds: roundSeconds(endSeconds) });
  };

  mergedCuts.forEach((cut) => {
    pushSegment(Math.max(cursor, 0), Math.min(cut.startSeconds, sourceDurationSeconds));
    cursor = Math.max(cursor, Math.min(cut.endSeconds, sourceDurationSeconds));
  });
  pushSegment(cursor, sourceDurationSeconds);

  const keptSeconds = roundSeconds(
    segments.reduce((total, segment) => total + (segment.endSeconds - segment.startSeconds), 0)
  );

  return {
    segments,
    sourceDurationSeconds: roundSeconds(sourceDurationSeconds),
    keptSeconds,
    removedSeconds: roundSeconds(Math.max(0, sourceDurationSeconds - keptSeconds)),
  };
}

/**
 * Every cut adds a segment boundary, so an edit with thousands of tiny cuts
 * would produce an EDL no exporter can render. Rather than truncating the
 * timeline — which would silently drop the end of the recording — the smallest
 * cuts are abandoned until the segment count fits, keeping more material.
 */
function boundCutCount(cuts: CutInterval[]): CutInterval[] {
  const budget = MAX_EDL_SEGMENTS - 1;
  if (cuts.length <= budget) return cuts;
  const kept = cuts
    .map((cut, order) => ({ cut, order }))
    .sort((a, b) => (b.cut.endSeconds - b.cut.startSeconds) - (a.cut.endSeconds - a.cut.startSeconds))
    .slice(0, budget)
    .sort((a, b) => a.order - b.order);
  return kept.map((entry) => entry.cut);
}

export function summarizeTranscriptEdit(
  doc: TranscriptEditorDocument,
  selection: TranscriptEditSelection = {},
  options: TranscriptEdlOptions = {}
): TranscriptEditSummary {
  const edl = buildTranscriptEdl(doc, selection, options);
  const wordIds = new Set(doc.words.map((word) => word.id));
  const removedWordCount = (selection.removedWordIds || []).filter((id) => wordIds.has(id)).length;
  const gapIds = new Set(findTranscriptSilenceGaps(doc, 0.001).map((gap) => gap.id));
  const trimmedSilenceCount = (selection.trimmedGapIds || []).filter((id) => gapIds.has(id)).length;

  return {
    removedWordCount,
    trimmedSilenceCount,
    removedSeconds: edl.removedSeconds,
    keptSeconds: edl.keptSeconds,
    sourceDurationSeconds: edl.sourceDurationSeconds,
    tightenedFraction: edl.sourceDurationSeconds > 0
      ? Math.min(1, Math.max(0, edl.removedSeconds / edl.sourceDurationSeconds))
      : 0,
    segmentCount: edl.segments.length,
  };
}

/** The transcript as it reads after the edit, for review before exporting. */
export function getKeptTranscriptText(
  doc: TranscriptEditorDocument,
  selection: TranscriptEditSelection = {}
): string {
  const removedWordIds = new Set(selection.removedWordIds || []);
  return doc.words
    .filter((word) => !removedWordIds.has(word.id))
    .map((word) => word.text)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/**
 * Maps a source timestamp onto the edited timeline, so playheads and markers
 * can follow an edit. Returns null for source time that the edit removed.
 */
export function mapSourceTimeToEditedTime(edl: TranscriptEdl, sourceSeconds: number): number | null {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) return null;
  let elapsed = 0;
  for (const segment of edl.segments) {
    if (sourceSeconds < segment.startSeconds) return null;
    if (sourceSeconds <= segment.endSeconds) {
      return roundSeconds(elapsed + (sourceSeconds - segment.startSeconds));
    }
    elapsed += segment.endSeconds - segment.startSeconds;
  }
  return null;
}

export function isTranscriptEditEmpty(edl: TranscriptEdl): boolean {
  return edl.segments.length === 1
    && edl.segments[0].startSeconds === 0
    && edl.segments[0].endSeconds === edl.sourceDurationSeconds;
}
