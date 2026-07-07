import { roundClipSeconds } from './recordingClips.ts';

export interface ClipSuggestionCaptionSegment {
  speakerName?: string;
  text: string;
  timestamp: string;
  interim?: boolean;
}

export interface ClipSuggestionMarker {
  label: string;
  seconds: number;
}

export type ClipSuggestionReason = 'marker' | 'question' | 'highlight-phrase' | 'speech-burst';

export interface ClipSuggestion {
  id: string;
  label: string;
  reason: ClipSuggestionReason;
  startSeconds: number;
  endSeconds: number;
  score: number;
}

export interface ClipSuggestionInput {
  captionSegments?: ClipSuggestionCaptionSegment[];
  markers?: ClipSuggestionMarker[];
  durationSeconds?: number | null;
}

const SUGGESTION_LEAD_IN_SECONDS = 5;
const SUGGESTION_WINDOW_SECONDS = 30;
const MIN_SUGGESTION_DURATION_SECONDS = 5;
const MAX_SUGGESTIONS = 6;
const SPEECH_BURST_WINDOW_SECONDS = 30;
const OVERLAP_MERGE_THRESHOLD = 0.5;
const MAX_LABEL_QUOTE_LENGTH = 44;

const QUESTION_STARTERS = /^(who|what|why|how|when|where|which|can|could|should|would|do|does|did|is|are|will)\b/i;

const HIGHLIGHT_PHRASES = [
  'amazing',
  'incredible',
  'important',
  'key point',
  'key takeaway',
  'takeaway',
  'the secret',
  'announcement',
  'announcing',
  'launch',
  'excited',
  'exciting',
  'wow',
  'let me show you',
  'check this out',
  'here is the thing',
  "here's the thing",
  'remember this',
  'big news',
  'game changer',
  'pro tip',
];

interface TimedCaptionSegment {
  seconds: number;
  text: string;
  speakerName: string;
}

function truncateQuote(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= MAX_LABEL_QUOTE_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_LABEL_QUOTE_LENGTH - 3).trimEnd()}...`;
}

function toTimedCaptionSegments(segments: ClipSuggestionCaptionSegment[]): TimedCaptionSegment[] {
  const finals = segments
    .filter((segment) => segment && !segment.interim && typeof segment.text === 'string' && segment.text.trim())
    .map((segment) => ({ segment, timeMs: Date.parse(segment.timestamp) }))
    .filter((entry) => Number.isFinite(entry.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  if (finals.length === 0) return [];
  const originMs = finals[0].timeMs;
  return finals.map((entry) => ({
    seconds: Math.max(0, (entry.timeMs - originMs) / 1000),
    text: entry.segment.text.trim(),
    speakerName: entry.segment.speakerName?.trim() || 'Speaker',
  }));
}

function isQuestionText(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (cleaned.includes('?')) return true;
  return QUESTION_STARTERS.test(cleaned) && cleaned.split(/\s+/).length >= 4;
}

function findHighlightPhrase(text: string): string | null {
  const lowered = text.toLowerCase();
  for (const phrase of HIGHLIGHT_PHRASES) {
    if (lowered.includes(phrase)) return phrase;
  }
  return null;
}

function clampSuggestionWindow(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number | null | undefined
): { startSeconds: number; endSeconds: number } | null {
  let start = Math.max(0, startSeconds);
  let end = Math.max(start, endSeconds);
  if (Number.isFinite(durationSeconds) && (durationSeconds as number) > 0) {
    const duration = durationSeconds as number;
    if (start >= duration) return null;
    end = Math.min(end, duration);
  }
  if (end - start < MIN_SUGGESTION_DURATION_SECONDS) return null;
  return { startSeconds: roundClipSeconds(start), endSeconds: roundClipSeconds(end) };
}

function overlapRatio(a: ClipSuggestion, b: ClipSuggestion): number {
  const overlap = Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
  if (overlap <= 0) return 0;
  const shortest = Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds);
  return shortest > 0 ? overlap / shortest : 1;
}

function buildMarkerSuggestions(
  markers: ClipSuggestionMarker[],
  durationSeconds: number | null | undefined
): ClipSuggestion[] {
  return markers
    .filter((marker) => marker && Number.isFinite(marker.seconds) && marker.seconds >= 0)
    .map((marker, index): ClipSuggestion | null => {
      const window = clampSuggestionWindow(
        marker.seconds - SUGGESTION_LEAD_IN_SECONDS,
        marker.seconds - SUGGESTION_LEAD_IN_SECONDS + SUGGESTION_WINDOW_SECONDS,
        durationSeconds
      );
      if (!window) return null;
      const label = marker.label?.trim() ? `Marker: ${truncateQuote(marker.label)}` : 'Marker moment';
      return {
        id: `marker-${index}`,
        label,
        reason: 'marker',
        ...window,
        score: 100,
      };
    })
    .filter((suggestion): suggestion is ClipSuggestion => suggestion !== null);
}

function buildCaptionMomentSuggestions(
  segments: TimedCaptionSegment[],
  durationSeconds: number | null | undefined
): ClipSuggestion[] {
  const suggestions: ClipSuggestion[] = [];
  segments.forEach((segment, index) => {
    const highlightPhrase = findHighlightPhrase(segment.text);
    const question = isQuestionText(segment.text);
    if (!highlightPhrase && !question) return;
    const window = clampSuggestionWindow(
      segment.seconds - 3,
      segment.seconds - 3 + SUGGESTION_WINDOW_SECONDS,
      durationSeconds
    );
    if (!window) return;
    if (question) {
      suggestions.push({
        id: `question-${index}`,
        label: `Question: "${truncateQuote(segment.text)}"`,
        reason: 'question',
        ...window,
        score: 70,
      });
      return;
    }
    suggestions.push({
      id: `highlight-${index}`,
      label: `Highlight: "${truncateQuote(segment.text)}"`,
      reason: 'highlight-phrase',
      ...window,
      score: 60,
    });
  });
  return suggestions;
}

function buildSpeechBurstSuggestions(
  segments: TimedCaptionSegment[],
  durationSeconds: number | null | undefined
): ClipSuggestion[] {
  if (segments.length < 3) return [];
  let best: { startSeconds: number; chars: number } | null = null;
  for (const anchor of segments) {
    const windowEnd = anchor.seconds + SPEECH_BURST_WINDOW_SECONDS;
    const chars = segments
      .filter((segment) => segment.seconds >= anchor.seconds && segment.seconds < windowEnd)
      .reduce((total, segment) => total + segment.text.length, 0);
    if (!best || chars > best.chars) {
      best = { startSeconds: anchor.seconds, chars };
    }
  }
  if (!best || best.chars === 0) return [];
  const window = clampSuggestionWindow(
    best.startSeconds - 2,
    best.startSeconds - 2 + SPEECH_BURST_WINDOW_SECONDS,
    durationSeconds
  );
  if (!window) return [];
  return [{
    id: 'speech-burst-0',
    label: 'Most active moment',
    reason: 'speech-burst',
    ...window,
    score: 40,
  }];
}

export function buildClipSuggestions(input: ClipSuggestionInput): ClipSuggestion[] {
  const segments = toTimedCaptionSegments(input.captionSegments || []);
  const candidates = [
    ...buildMarkerSuggestions(input.markers || [], input.durationSeconds),
    ...buildCaptionMomentSuggestions(segments, input.durationSeconds),
    ...buildSpeechBurstSuggestions(segments, input.durationSeconds),
  ].sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds);

  const selected: ClipSuggestion[] = [];
  for (const candidate of candidates) {
    if (selected.length >= MAX_SUGGESTIONS) break;
    if (selected.some((existing) => overlapRatio(existing, candidate) > OVERLAP_MERGE_THRESHOLD)) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.startSeconds - b.startSeconds);
}
