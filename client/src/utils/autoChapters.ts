/**
 * Deterministic, offline episode helpers used when no AI model is available
 * (no Chrome built-in AI, no server key): chapters from topic shifts,
 * highlight windows and an extractive summary. Everything runs on the
 * transcript text, so it is instant and free.
 *
 * Chapters follow TextTiling: the transcript is cut into ~45 s windows, each
 * window becomes a TF-IDF vector, and a chapter starts where the vocabulary
 * before and after a gap is least alike (the deepest similarity valleys).
 * Recording markers always start a chapter and lend it their label.
 */
import type { AiHighlightSuggestion } from './clipSuggestions.ts';

export interface TimedTranscriptSegment {
  seconds: number;
  text: string;
  speaker?: string;
}

export interface AutoChapterMarker {
  seconds: number;
  label: string;
}

export interface AutoChapter {
  seconds: number;
  title: string;
  /** Text of the chapter, for optional AI retitling. */
  text: string;
}

export interface AutoChapterOptions {
  windowSeconds?: number;
  minChapterSeconds?: number;
  maxChapters?: number;
}

const STOP_WORDS = new Set((
  'a about above after again against all also am an and any are as at be because been before being below between both '
  + 'but by can could did do does doing done down during each else even ever every few for from further get gets getting '
  + 'go goes going gone got gotta had has have having he her here hers herself him himself his how i if in into is it its '
  + 'itself just kind know let like lot lots made make makes making many may maybe me might mine more most much must my '
  + 'myself need no nor not now of off oh ok okay on once one only or other our ours ourselves out over own pretty put '
  + 'quite really right said same say saying says see she should so some something sort still such sure take than that '
  + 'thats the their theirs them themselves then there these they thing things think this those though through to too '
  + 'uh um umm up us very want was way we well went were what when where which while who whom why will with would yeah '
  + 'yes yet you your yours yourself yourselves actually basically gonna wanna kinda lets dont doesnt didnt cant wont isnt '
  + 'arent wasnt im ive youre youve weve theyre thats whats theres hes shes ill youll well wed id hmm mhm guess mean '
  + 'look looking come came coming back time today year years people good great new first two three'
).split(/\s+/));

export function tokenizeForTopics(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token))
    .map(stemToken);
}

/** A light suffix stripper so "pricing", "prices" and "price" count as one topic word. */
export function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  return token;
}

interface TopicWindow {
  startSeconds: number;
  endSeconds: number;
  text: string;
  terms: Map<string, number>;
  /** Most frequent surface form for each stem, for readable titles. */
  surface: Map<string, string>;
}

function buildTopicWindows(segments: TimedTranscriptSegment[], windowSeconds: number): TopicWindow[] {
  const sorted = segments
    .filter((segment) => Number.isFinite(segment.seconds) && segment.text?.trim())
    .sort((a, b) => a.seconds - b.seconds);
  const windows: TopicWindow[] = [];
  for (const segment of sorted) {
    const index = Math.floor(segment.seconds / windowSeconds);
    let window = windows[windows.length - 1];
    if (!window || Math.floor(window.startSeconds / windowSeconds) !== index) {
      window = { startSeconds: index * windowSeconds, endSeconds: (index + 1) * windowSeconds, text: '', terms: new Map(), surface: new Map() };
      windows.push(window);
    }
    window.text = `${window.text} ${segment.text.trim()}`.trim();
    for (const raw of segment.text.toLowerCase().split(/[^\p{L}\p{N}’']+/u)) {
      const cleaned = raw.replace(/[’']/g, '');
      if (cleaned.length <= 2 || STOP_WORDS.has(cleaned) || /^\d+$/.test(cleaned)) continue;
      const stem = stemToken(cleaned);
      window.terms.set(stem, (window.terms.get(stem) || 0) + 1);
      if (!window.surface.has(stem) || cleaned.length < (window.surface.get(stem) || '').length) window.surface.set(stem, cleaned);
    }
  }
  return windows;
}

function inverseDocumentFrequency(windows: TopicWindow[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const window of windows) {
    for (const term of window.terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of documentFrequency) idf.set(term, Math.log((1 + windows.length) / (1 + count)) + 1);
  return idf;
}

function tfidfVector(terms: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const vector = new Map<string, number>();
  let total = 0;
  for (const count of terms.values()) total += count;
  for (const [term, count] of terms) vector.set(term, (count / Math.max(1, total)) * (idf.get(term) || 1));
  return vector;
}

function addVectors(vectors: Map<string, number>[]): Map<string, number> {
  const sum = new Map<string, number>();
  for (const vector of vectors) for (const [term, value] of vector) sum.set(term, (sum.get(term) || 0) + value);
  return sum;
}

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, value] of a) {
    normA += value * value;
    const other = b.get(term);
    if (other) dot += value * other;
  }
  for (const value of b.values()) normB += value * value;
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function topTerms(vector: Map<string, number>, surface: Map<string, string>, count: number): string[] {
  return Array.from(vector.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([stem]) => surface.get(stem) || stem);
}

function titleCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

export function buildChapterTitleFromTerms(terms: string[]): string {
  const words = terms.filter(Boolean).slice(0, 3).map(titleCase);
  if (words.length === 0) return 'Discussion';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} & ${words[words.length - 1]}`;
}

/**
 * Chapters from topic shifts plus recording markers. The first chapter always
 * starts at 0:00 (YouTube requires it) and chapters are at least
 * `minChapterSeconds` apart.
 */
export function buildAutoChapters(
  segments: TimedTranscriptSegment[],
  markers: AutoChapterMarker[] = [],
  durationSeconds?: number | null,
  options: AutoChapterOptions = {}
): AutoChapter[] {
  const windowSeconds = options.windowSeconds ?? 45;
  const windows = buildTopicWindows(segments, windowSeconds);
  const lastSpeech = windows.length ? windows[windows.length - 1].endSeconds : 0;
  const duration = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0 ? durationSeconds as number : lastSpeech;
  const minChapter = options.minChapterSeconds ?? Math.max(60, Math.min(300, duration / 12));
  const maxChapters = options.maxChapters ?? Math.max(2, Math.min(15, Math.floor(duration / minChapter)));
  if (windows.length === 0) {
    return markersToChapters(markers, duration);
  }

  const idf = inverseDocumentFrequency(windows);
  const vectors = windows.map((window) => tfidfVector(window.terms, idf));

  // Similarity across each gap between windows, comparing a block of two windows on each side.
  const block = 2;
  const gaps: Array<{ index: number; seconds: number; similarity: number }> = [];
  for (let gap = 1; gap < windows.length; gap += 1) {
    const before = addVectors(vectors.slice(Math.max(0, gap - block), gap));
    const after = addVectors(vectors.slice(gap, gap + block));
    gaps.push({ index: gap, seconds: windows[gap].startSeconds, similarity: cosineSimilarity(before, after) });
  }
  // Depth score: how far the similarity dips below the peaks on either side.
  const depths = gaps.map((gap, position) => {
    let leftPeak = gap.similarity;
    for (let index = position - 1; index >= 0 && gaps[index].similarity >= leftPeak; index -= 1) leftPeak = gaps[index].similarity;
    let rightPeak = gap.similarity;
    for (let index = position + 1; index < gaps.length && gaps[index].similarity >= rightPeak; index += 1) rightPeak = gaps[index].similarity;
    return { ...gap, depth: leftPeak - gap.similarity + (rightPeak - gap.similarity) };
  });
  const mean = depths.reduce((total, gap) => total + gap.depth, 0) / Math.max(1, depths.length);
  const variance = depths.reduce((total, gap) => total + (gap.depth - mean) ** 2, 0) / Math.max(1, depths.length);
  const cutoff = Math.max(0.05, mean - Math.sqrt(variance) / 2);

  const markerStarts = markers
    .filter((marker) => Number.isFinite(marker.seconds) && marker.seconds >= 0 && marker.seconds < Math.max(duration, 1))
    .sort((a, b) => a.seconds - b.seconds);
  const starts: Array<{ seconds: number; label?: string }> = [{ seconds: 0 }];
  for (const marker of markerStarts) {
    if (marker.seconds < 10) {
      if (marker.label?.trim()) starts[0].label = marker.label.trim();
      continue;
    }
    if (starts.some((start) => Math.abs(start.seconds - marker.seconds) < Math.min(minChapter, 30))) continue;
    starts.push({ seconds: marker.seconds, ...(marker.label?.trim() ? { label: marker.label.trim() } : {}) });
  }
  const candidates = depths
    .filter((gap) => gap.depth >= cutoff)
    .sort((a, b) => b.depth - a.depth);
  for (const candidate of candidates) {
    if (starts.length >= maxChapters) break;
    if (duration - candidate.seconds < minChapter / 2) continue;
    if (starts.some((start) => Math.abs(start.seconds - candidate.seconds) < minChapter)) continue;
    starts.push({ seconds: candidate.seconds });
  }
  starts.sort((a, b) => a.seconds - b.seconds);

  const usedTitles = new Set<string>();
  return starts.map((start, index) => {
    const end = starts[index + 1]?.seconds ?? Number.POSITIVE_INFINITY;
    const inside = windows.filter((window) => window.startSeconds >= start.seconds - 1e-6 && window.startSeconds < end);
    const text = inside.map((window) => window.text).join(' ').trim();
    let title = start.label || '';
    if (!title) {
      const vector = addVectors(inside.map((window) => tfidfVector(window.terms, idf)));
      const surface = new Map<string, string>();
      for (const window of inside) for (const [stem, form] of window.surface) if (!surface.has(stem)) surface.set(stem, form);
      const fresh = topTerms(vector, surface, 6).filter((term) => !usedTitles.has(term));
      title = buildChapterTitleFromTerms(fresh.length ? fresh : topTerms(vector, surface, 3));
      fresh.slice(0, 3).forEach((term) => usedTitles.add(term));
      if (index === 0 && start.seconds === 0 && !text) title = 'Intro';
    }
    return { seconds: Math.round(start.seconds), title, text };
  });
}

function markersToChapters(markers: AutoChapterMarker[], duration: number): AutoChapter[] {
  const sorted = markers.filter((marker) => Number.isFinite(marker.seconds) && marker.seconds >= 0).sort((a, b) => a.seconds - b.seconds);
  if (sorted.length === 0) return [];
  const chapters: AutoChapter[] = [];
  if (sorted[0].seconds >= 10) chapters.push({ seconds: 0, title: 'Intro', text: '' });
  for (const marker of sorted) {
    if (duration > 0 && marker.seconds >= duration) continue;
    if (chapters.some((chapter) => Math.abs(chapter.seconds - marker.seconds) < 10)) continue;
    chapters.push({ seconds: Math.round(marker.seconds), title: marker.label?.trim() || 'Marker', text: '' });
  }
  if (chapters[0]?.seconds !== 0 && chapters[0]) chapters[0] = { ...chapters[0], seconds: 0 };
  return chapters;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"“])/;

/** The `count` most topical sentences, in their original order. */
export function buildExtractiveSummary(text: string, count = 3): string[] {
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.replace(/^\[[\d:]+\]\s*[^:]{1,40}:\s*/, '').split(SENTENCE_SPLIT))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).length >= 6 && sentence.length <= 320);
  if (sentences.length === 0) return [];
  const termCounts = sentences.map((sentence) => {
    const counts = new Map<string, number>();
    for (const token of tokenizeForTopics(sentence)) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of termCounts) for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  const globalCounts = new Map<string, number>();
  for (const counts of termCounts) for (const [term, value] of counts) globalCounts.set(term, (globalCounts.get(term) || 0) + value);
  const scored = sentences.map((sentence, index) => {
    let score = 0;
    for (const [term] of termCounts[index]) {
      const df = documentFrequency.get(term) || 1;
      // Reward words that recur across the episode (its themes) but are not everywhere.
      score += Math.log(1 + (globalCounts.get(term) || 0)) * Math.log((1 + sentences.length) / df);
    }
    return { sentence, index, score: score / Math.sqrt(Math.max(1, termCounts[index].size)) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence);
}

/** The episode's most characteristic words, for a fallback title. */
export function buildKeywordTitle(text: string): string {
  const counts = new Map<string, number>();
  const surface = new Map<string, string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}’']+/u)) {
    const cleaned = raw.replace(/[’']/g, '');
    if (cleaned.length <= 3 || STOP_WORDS.has(cleaned) || /^\d+$/.test(cleaned)) continue;
    const stem = stemToken(cleaned);
    counts.set(stem, (counts.get(stem) || 0) + 1);
    if (!surface.has(stem) || cleaned.length < (surface.get(stem) || '').length) surface.set(stem, cleaned);
  }
  const terms = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([stem]) => surface.get(stem) || stem);
  return buildChapterTitleFromTerms(terms);
}

/** Groups word timings into sentence-sized segments (split on end punctuation, pauses or 12 s). */
export function buildTimedSegmentsFromWords(
  words: Array<{ word: string; start: number; end: number }>,
  maxSeconds = 12,
  pauseSeconds = 1.2
): TimedTranscriptSegment[] {
  const segments: TimedTranscriptSegment[] = [];
  let current: { seconds: number; words: string[]; lastEnd: number } | null = null;
  for (const word of words) {
    if (!word?.word?.trim() || !Number.isFinite(word.start)) continue;
    if (current && (word.start - current.lastEnd > pauseSeconds || word.start - current.seconds > maxSeconds)) {
      segments.push({ seconds: current.seconds, text: current.words.join(' ') });
      current = null;
    }
    current ||= { seconds: word.start, words: [], lastEnd: word.end };
    current.words.push(word.word.trim());
    current.lastEnd = word.end;
    if (/[.!?]$/.test(word.word.trim())) {
      segments.push({ seconds: current.seconds, text: current.words.join(' ') });
      current = null;
    }
  }
  if (current) segments.push({ seconds: current.seconds, text: current.words.join(' ') });
  return segments;
}

const TIMED_LINE = /^\[(?:(\d+):)?(\d+):(\d{2})\]\s*(?:([^:\n]{1,60}):\s*)?(.*)$/;

/** Reads "[m:ss] Speaker: text" lines (buildTranscriptFromCaptions) back into timed segments. */
export function parseTimedTranscriptLines(transcript: string): TimedTranscriptSegment[] {
  const segments: TimedTranscriptSegment[] = [];
  for (const line of transcript.split('\n')) {
    const match = TIMED_LINE.exec(line.trim());
    if (!match) continue;
    const seconds = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const text = match[5].trim();
    if (!text) continue;
    segments.push({ seconds, text, ...(match[4] ? { speaker: match[4].trim() } : {}) });
  }
  return segments;
}

const HIGHLIGHT_CUES = /\b(secret|mistake|lesson|biggest|never|always|best|worst|important|key|surprising|story|truth|tip|advice|learned|changed|why|how)\b/i;

/**
 * Highlight windows without a language model: 30 s windows scored by
 * distinctive vocabulary (TF-IDF mass), questions and strong-claim cue words,
 * and back-and-forth between speakers, then the best non-overlapping ones.
 */
export function buildDeterministicHighlights(
  segments: TimedTranscriptSegment[],
  durationSeconds?: number | null,
  count = 5,
  windowSeconds = 30
): AiHighlightSuggestion[] {
  const sorted = segments.filter((segment) => Number.isFinite(segment.seconds) && segment.text?.trim()).sort((a, b) => a.seconds - b.seconds);
  if (sorted.length < 2) return [];
  const duration = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0
    ? durationSeconds as number
    : sorted[sorted.length - 1].seconds + 10;
  const documentFrequency = new Map<string, number>();
  const segmentTerms = sorted.map((segment) => {
    const terms = new Set(tokenizeForTopics(segment.text));
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    return terms;
  });
  const candidates: Array<AiHighlightSuggestion & { score: number }> = [];
  for (let anchor = 0; anchor < sorted.length; anchor += 1) {
    const start = Math.max(0, sorted[anchor].seconds - 1);
    const end = Math.min(duration, start + windowSeconds);
    if (end - start < 8) continue;
    let score = 0;
    const speakers: string[] = [];
    let firstText = '';
    for (let index = anchor; index < sorted.length && sorted[index].seconds < end; index += 1) {
      const segment = sorted[index];
      firstText ||= segment.text.trim();
      for (const term of segmentTerms[index]) score += Math.log((1 + sorted.length) / (documentFrequency.get(term) || 1));
      if (segment.text.includes('?')) score += 3;
      if (HIGHLIGHT_CUES.test(segment.text)) score += 2;
      if (/!/.test(segment.text)) score += 1;
      if (segment.speaker && speakers[speakers.length - 1] !== segment.speaker) speakers.push(segment.speaker);
    }
    score += Math.min(4, Math.max(0, speakers.length - 1)) * 1.5;
    candidates.push({
      startSeconds: Math.round(start * 10) / 10,
      endSeconds: Math.round(end * 10) / 10,
      title: firstText.length > 60 ? `${firstText.slice(0, 57).trimEnd()}...` : firstText,
      reason: 'Distinctive topic and lively exchange',
      score,
    });
  }
  const selected: Array<AiHighlightSuggestion & { score: number }> = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (selected.length >= count) break;
    if (selected.some((other) => candidate.startSeconds < other.endSeconds && other.startSeconds < candidate.endSeconds)) continue;
    selected.push(candidate);
  }
  return selected
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...highlight }) => highlight);
}
