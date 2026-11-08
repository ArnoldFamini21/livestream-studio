/**
 * Word-synced captions burned into exported clips. Words come from the
 * transcript's word timings (TranscriptWord[], in seconds on the recording
 * timeline); they are grouped into short cues and drawn on the clip canvas
 * with the brand font and colour, the word being spoken highlighted.
 */
import type { TranscriptWord } from './transcriptCleanup.ts';

export interface ClipCaptionWord {
  text: string;
  /** Seconds from the clip start. */
  start: number;
  end: number;
}

export interface ClipCaptionCue {
  start: number;
  end: number;
  words: ClipCaptionWord[];
}

export interface ClipCaptionStyle {
  /** CSS font-family stack, e.g. the loaded brand font. */
  fontFamily: string;
  /** Colour of the word being spoken. */
  accentColor: string;
  textColor?: string;
  uppercase?: boolean;
}

export interface CueOptions {
  maxWords?: number;
  maxChars?: number;
  maxSeconds?: number;
  /** A pause longer than this starts a new cue. */
  pauseSeconds?: number;
}

/** Words of the clip range, re-timed to the clip, grouped into short readable cues. */
export function buildClipCaptionCues(
  words: TranscriptWord[],
  range: { startSeconds: number; endSeconds: number },
  options: CueOptions = {}
): ClipCaptionCue[] {
  const maxWords = options.maxWords ?? 5;
  const maxChars = options.maxChars ?? 28;
  const maxSeconds = options.maxSeconds ?? 2.2;
  const pauseSeconds = options.pauseSeconds ?? 0.7;
  const clipDuration = range.endSeconds - range.startSeconds;
  const inRange = words
    .filter((word) => word && word.word?.trim() && word.end > range.startSeconds && word.start < range.endSeconds)
    .map((word) => ({
      text: word.word.trim(),
      start: Math.max(0, word.start - range.startSeconds),
      end: Math.min(clipDuration, Math.max(word.start, word.end) - range.startSeconds),
    }))
    .sort((a, b) => a.start - b.start);

  const cues: ClipCaptionCue[] = [];
  let current: ClipCaptionWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    cues.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
    current = [];
  };
  for (const word of inRange) {
    const previous = current[current.length - 1];
    const chars = current.reduce((total, item) => total + item.text.length + 1, 0) + word.text.length;
    if (
      previous && (
        current.length >= maxWords
        || chars > maxChars
        || word.end - current[0].start > maxSeconds
        || word.start - previous.end > pauseSeconds
        || /[.!?]$/.test(previous.text)
      )
    ) {
      flush();
    }
    current.push(word);
  }
  flush();
  // Hold each cue until the next one starts (up to half a second) so captions do not flicker.
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    const holdUntil = next ? Math.min(next.start, cue.end + 0.5) : Math.min(clipDuration, cue.end + 0.5);
    return { ...cue, end: Math.max(cue.end, holdUntil) };
  });
}

export function findActiveCue(cues: ClipCaptionCue[], seconds: number): ClipCaptionCue | null {
  for (const cue of cues) {
    if (seconds >= cue.start && seconds < cue.end) return cue;
    if (cue.start > seconds) break;
  }
  return null;
}

interface MeasureContext {
  measureText(text: string): { width: number };
}

/** Breaks a cue's words into at most two lines that fit `maxWidth`. */
export function layoutCaptionLines(context: MeasureContext, words: string[], maxWidth: number): string[][] {
  const lines: string[][] = [[]];
  for (const word of words) {
    const line = lines[lines.length - 1];
    const candidate = [...line, word].join(' ');
    if (line.length > 0 && context.measureText(candidate).width > maxWidth && lines.length < 2) {
      lines.push([word]);
    } else {
      line.push(word);
    }
  }
  return lines.filter((line) => line.length > 0);
}

/** Draws the cue active at `seconds` near the bottom of the frame (inside the Shorts/Reels safe area). */
export function drawClipCaption(
  context: CanvasRenderingContext2D,
  cues: ClipCaptionCue[],
  seconds: number,
  style: ClipCaptionStyle,
  width: number,
  height: number
): void {
  const cue = findActiveCue(cues, seconds);
  if (!cue) return;
  const portrait = height > width;
  const fontSize = Math.round(Math.min(width, height) * (portrait ? 0.075 : 0.06));
  const textColor = style.textColor || '#ffffff';
  const transform = (text: string) => (style.uppercase ? text.toUpperCase() : text);
  context.save();
  context.font = `800 ${fontSize}px ${style.fontFamily}`;
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  const words = cue.words.map((word) => transform(word.text));
  const lines = layoutCaptionLines(context, words, width * 0.86);
  const lineHeight = fontSize * 1.22;
  const baseY = height * (portrait ? 0.72 : 0.84) - ((lines.length - 1) * lineHeight) / 2;
  const spaceWidth = context.measureText(' ').width;
  let wordIndex = 0;
  lines.forEach((line, lineIndex) => {
    const lineWidth = context.measureText(line.join(' ')).width;
    let x = (width - lineWidth) / 2;
    const y = baseY + lineIndex * lineHeight;
    for (const text of line) {
      const word = cue.words[wordIndex];
      const active = word && seconds >= word.start && seconds < Math.max(word.end, word.start + 0.12);
      const wordWidth = context.measureText(text).width;
      context.lineWidth = Math.max(2, fontSize * 0.16);
      context.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      context.strokeText(text, x, y);
      context.fillStyle = active ? style.accentColor : textColor;
      context.fillText(text, x, y);
      x += wordWidth + spaceWidth;
      wordIndex += 1;
    }
  });
  context.restore();
}
