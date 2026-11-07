/**
 * Pure helpers for in-browser (Whisper) transcription of long recordings.
 *
 * A podcast-length track is never decoded at once: it is read in 30 s windows
 * (Whisper's native input length) that overlap by a few seconds, each window
 * is downmixed and resampled to 16 kHz mono, transcribed on its own, and the
 * per-window word timings are stitched back onto the track timeline. A word
 * that falls inside an overlap is taken from the window in which it sits
 * further from the edge, where Whisper has the most context and is least
 * likely to have cut it in half.
 */
import type { TranscriptWord } from './transcriptCleanup.ts';

export const WHISPER_SAMPLE_RATE = 16_000;
export const TRANSCRIPTION_WINDOW_SECONDS = 30;
export const TRANSCRIPTION_WINDOW_OVERLAP_SECONDS = 4;
/** Below this RMS (about -50 dBFS) a window is treated as silence and skipped; Whisper invents text on silence. */
export const SILENT_WINDOW_RMS = 0.003;

export interface TranscriptionWindow {
  index: number;
  /** Seconds into the track where the decoded audio starts. */
  startSeconds: number;
  endSeconds: number;
  /** Words whose midpoint lies in [keepStart, keepEnd) belong to this window. */
  keepStartSeconds: number;
  keepEndSeconds: number;
}

export function planTranscriptionWindows(
  durationSeconds: number,
  windowSeconds = TRANSCRIPTION_WINDOW_SECONDS,
  overlapSeconds = TRANSCRIPTION_WINDOW_OVERLAP_SECONDS
): TranscriptionWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const windowLength = Math.max(1, windowSeconds);
  const overlap = Math.min(Math.max(0, overlapSeconds), windowLength / 2);
  const step = windowLength - overlap;
  const windows: TranscriptionWindow[] = [];
  for (let start = 0, index = 0; start < durationSeconds; start += step, index += 1) {
    const end = Math.min(durationSeconds, start + windowLength);
    windows.push({
      index,
      startSeconds: start,
      endSeconds: end,
      keepStartSeconds: index === 0 ? 0 : start + overlap / 2,
      keepEndSeconds: end >= durationSeconds ? Number.POSITIVE_INFINITY : end - overlap / 2,
    });
    if (end >= durationSeconds) break;
  }
  return windows;
}

/** One word chunk from the transformers.js ASR pipeline (`return_timestamps: 'word'`). */
export interface WhisperWordChunk {
  text: string;
  timestamp: [number, number | null] | number[];
}

/**
 * Maps a window's word chunks (seconds relative to the window) onto the track
 * timeline and keeps only the words the window owns.
 */
export function mapWindowWords(window: TranscriptionWindow, chunks: WhisperWordChunk[]): TranscriptWord[] {
  const windowLength = window.endSeconds - window.startSeconds;
  const words: TranscriptWord[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== 'string') continue;
    const word = chunk.text.trim();
    if (!word) continue;
    const rawStart = Number(chunk.timestamp?.[0]);
    if (!Number.isFinite(rawStart)) continue;
    const rawEndValue = chunk.timestamp?.[1];
    const rawEnd = rawEndValue === null || rawEndValue === undefined || !Number.isFinite(Number(rawEndValue))
      ? Math.min(windowLength, rawStart + 0.3)
      : Number(rawEndValue);
    const relStart = Math.min(Math.max(0, rawStart), windowLength);
    const relEnd = Math.min(Math.max(relStart, rawEnd), windowLength);
    const start = window.startSeconds + relStart;
    const end = window.startSeconds + relEnd;
    const middle = (start + end) / 2;
    if (middle < window.keepStartSeconds || middle >= window.keepEndSeconds) continue;
    words.push({ word, start: roundTime(start), end: roundTime(end) });
  }
  return words;
}

/** Joins per-window words in time order, dropping exact duplicates an overlap can produce. */
export function stitchTranscriptWords(perWindow: TranscriptWord[][]): TranscriptWord[] {
  const all = perWindow.flat().sort((a, b) => a.start - b.start || a.end - b.end);
  const words: TranscriptWord[] = [];
  for (const word of all) {
    const previous = words[words.length - 1];
    if (
      previous
      && previous.word.toLowerCase() === word.word.toLowerCase()
      && Math.abs(previous.start - word.start) < 0.15
    ) {
      continue;
    }
    if (previous && word.start < previous.end) {
      // Keep timings monotonic for the cleanup editor and caption cues.
      const start = Math.max(word.start, previous.start);
      words.push({ ...word, start, end: Math.max(start, word.end) });
      continue;
    }
    words.push(word);
  }
  return words;
}

export function buildTranscriptTextFromWords(words: TranscriptWord[]): string {
  return words
    .map((word) => word.word)
    .join(' ')
    .replace(/\s+([,.!?;:%])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Sample offset of the quietest `frameSeconds` stretch within the last
 * `searchSeconds` of `samples`, so a long track can be cut into upload chunks
 * between words instead of through one.
 */
export function findQuietestCutOffset(
  samples: Float32Array,
  sampleRate: number,
  searchSeconds = 8,
  frameSeconds = 0.2
): number {
  const frame = Math.max(1, Math.round(frameSeconds * sampleRate));
  const searchStart = Math.max(0, samples.length - Math.round(searchSeconds * sampleRate));
  let bestOffset = samples.length;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let start = searchStart; start + frame <= samples.length; start += frame) {
    let energy = 0;
    for (let index = start; index < start + frame; index += 1) energy += samples[index] * samples[index];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestOffset = start + Math.floor(frame / 2);
    }
  }
  return bestOffset;
}

export function isSilentWindow(samples: Float32Array, threshold = SILENT_WINDOW_RMS): boolean {
  return computeRms(samples) < threshold;
}

/**
 * Downmixes planar channels and resamples them to `targetRate`. Each output
 * sample averages the source samples it covers (a box low-pass, enough to keep
 * 48 kHz speech from aliasing at 16 kHz), with linear interpolation when
 * upsampling.
 */
export function downmixAndResample(
  channels: Float32Array[],
  sourceRate: number,
  targetRate = WHISPER_SAMPLE_RATE
): Float32Array {
  const frameCount = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  if (frameCount === 0 || !Number.isFinite(sourceRate) || sourceRate <= 0) return new Float32Array(0);
  const mono = new Float32Array(frameCount);
  const channelCount = Math.max(1, channels.length);
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) mono[index] += channel[index] / channelCount;
  }
  if (sourceRate === targetRate) return mono;

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.floor(frameCount / ratio));
  const output = new Float32Array(outputLength);
  if (ratio > 1) {
    for (let index = 0; index < outputLength; index += 1) {
      const from = index * ratio;
      const to = Math.min(frameCount, from + ratio);
      let sum = 0;
      let weight = 0;
      for (let position = Math.floor(from); position < Math.ceil(to); position += 1) {
        const overlap = Math.min(position + 1, to) - Math.max(position, from);
        if (overlap <= 0) continue;
        sum += mono[position] * overlap;
        weight += overlap;
      }
      output[index] = weight > 0 ? sum / weight : 0;
    }
    return output;
  }
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(frameCount - 1, left + 1);
    const fraction = position - left;
    output[index] = mono[left] * (1 - fraction) + mono[right] * fraction;
  }
  return output;
}

/**
 * Whisper language for a BCP-47 caption language ('en-US' -> 'en'). Filipino
 * maps to Tagalog, the code Whisper was trained with. Unknown values let the
 * model detect the language.
 */
export function toWhisperLanguage(language: string | undefined | null): string | undefined {
  const base = (language || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!base || !/^[a-z]{2,3}$/.test(base)) return undefined;
  if (base === 'fil' || base === 'tl') return 'tl';
  if (base === 'iw') return 'he';
  if (base === 'zh' || base === 'yue') return base;
  return base.length === 2 ? base : undefined;
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}
