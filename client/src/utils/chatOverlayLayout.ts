import type { ChatOverlayLayout as ChatOverlayShape, ChatOverlaySide, ChatOverlaySize } from '@studio/shared';
import type { ChatOverlayComment, ChatOverlaySource } from './chatOverlayComments.ts';

/**
 * The single layout of the on-screen chat overlay. Comments + settings +
 * canvas size in, a flat list of drawing primitives out (rounded rectangles
 * and single-line texts in output pixels). The DOM preview (SVG) and the
 * compositor (canvas) both only replay these primitives, so what the host
 * sees is what viewers and recordings get, in 1920x1080 and 1080x1920.
 *
 * Layout runs only when comments, settings, canvas, bottom inset or fonts
 * change (see createChatOverlayLayoutCache); the 30 fps draw loop never
 * measures or wraps text.
 */

export interface ChatOverlayLayoutSettings {
  size: ChatOverlaySize;
  layout: ChatOverlayShape;
  side: ChatOverlaySide;
}

export interface ChatOverlayCanvas {
  width: number;
  height: number;
}

/** Width in px of `text` set in the CSS font shorthand `font`. */
export type TextMeasure = (font: string, text: string) => number;

export interface ChatOverlayRect {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill: string;
}

export interface ChatOverlayText {
  kind: 'text';
  /** Left edge, text baseline. */
  x: number;
  y: number;
  text: string;
  fontSize: number;
  weight: 400 | 600 | 700;
  fill: string;
}

export type ChatOverlayPrimitive = ChatOverlayRect | ChatOverlayText;

export interface ChatOverlayRow {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  question: boolean;
  lines: number;
}

export interface ChatOverlayLayoutResult {
  canvas: ChatOverlayCanvas;
  primitives: ChatOverlayPrimitive[];
  rows: ChatOverlayRow[];
  /** Union of all cards, null when nothing is shown. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** Comments that did not fit and were left out (oldest first). */
  omitted: number;
}

export const CHAT_OVERLAY_COLORS = {
  card: 'rgba(15, 23, 42, 0.86)',
  author: '#bfdbfe',
  text: '#f8fafc',
  questionFill: '#f59e0b',
  questionText: '#111827',
  accent: { studio: '#6366f1', youtube: '#ef4444', facebook: '#3b82f6' } as Record<ChatOverlaySource, string>,
} as const;

/** Base values for a 1080-unit short side; everything scales with the canvas. */
const SIZE_SPEC: Record<ChatOverlaySize, { font: number; width: number }> = {
  s: { font: 24, width: 440 },
  m: { font: 30, width: 540 },
  l: { font: 38, width: 680 },
};
const LAYOUT_SPEC: Record<ChatOverlayShape, { widthFactor: number; maxRows: number; maxHeightFraction: number }> = {
  regular: { widthFactor: 1, maxRows: 5, maxHeightFraction: 0.62 },
  tall: { widthFactor: 0.82, maxRows: 8, maxHeightFraction: 0.82 },
  wide: { widthFactor: 1.5, maxRows: 4, maxHeightFraction: 0.45 },
};
/** Hard cap on the rows any layout may draw, and on wrapped message lines per comment. */
export const CHAT_OVERLAY_ABSOLUTE_MAX_ROWS = 8;
export const CHAT_OVERLAY_MAX_LINES = 3;
const QUESTION_LABEL = 'Question';

export function getChatOverlayMaxRows(layout: ChatOverlayShape): number {
  return Math.min(CHAT_OVERLAY_ABSOLUTE_MAX_ROWS, LAYOUT_SPEC[layout].maxRows);
}

export function chatOverlayFont(weight: number, fontSize: number, family: string): string {
  return `${weight} ${fontSize}px ${family}`;
}

/** Remembers wrapped lines and fitted strings so repeated layouts do no new measuring. */
export interface ChatOverlayWrapCache {
  lines: Map<string, string[]>;
  fitted: Map<string, string>;
}

export function createChatOverlayWrapCache(): ChatOverlayWrapCache {
  return { lines: new Map(), fitted: new Map() };
}

const WRAP_CACHE_LIMIT = 400;

function remember<T>(map: Map<string, T>, key: string, value: T): T {
  if (map.size >= WRAP_CACHE_LIMIT) map.clear();
  map.set(key, value);
  return value;
}

/** Longest prefix of `text` (plus an ellipsis when cut) that fits `maxWidth`. */
function fitText(text: string, font: string, maxWidth: number, measure: TextMeasure): string {
  if (measure(font, text) <= maxWidth) return text;
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(font, `${points.slice(0, mid).join('').trimEnd()}\u2026`) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low === 0 ? '\u2026' : `${points.slice(0, low).join('').trimEnd()}\u2026`;
}

/** Greedy word wrap; a word wider than the line is split by characters. The last allowed line ends in an ellipsis when cut. */
export function wrapOverlayText(text: string, font: string, maxWidth: number, maxLines: number, measure: TextMeasure): string[] {
  const lines: string[] = [];
  let current = '';
  let truncated = false;
  const push = (line: string): boolean => {
    if (lines.length >= maxLines) { truncated = true; return false; }
    lines.push(line);
    return true;
  };
  outer: for (const word of text.split(' ')) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (measure(font, candidate) <= maxWidth) { current = candidate; continue; }
    if (current && !push(current)) break;
    current = '';
    if (measure(font, word) <= maxWidth) { current = word; continue; }
    // A word wider than a line: break it by characters.
    let chunk = '';
    for (const char of Array.from(word)) {
      if (measure(font, chunk + char) <= maxWidth || !chunk) { chunk += char; continue; }
      if (!push(chunk)) break outer;
      chunk = char;
    }
    current = chunk;
  }
  if (!truncated && current) truncated = !push(current);
  if (truncated && lines.length > 0) {
    const last = lines.length - 1;
    // The text continues past the last allowed line: mark it.
    lines[last] = fitText(`${lines[last]}\u2026`, font, maxWidth, measure);
  }
  return lines;
}

function wrapCached(cache: ChatOverlayWrapCache, text: string, font: string, maxWidth: number, maxLines: number, measure: TextMeasure): string[] {
  const key = `${font}|${Math.round(maxWidth)}|${maxLines}|${text}`;
  return cache.lines.get(key) ?? remember(cache.lines, key, wrapOverlayText(text, font, maxWidth, maxLines, measure));
}

function fitCached(cache: ChatOverlayWrapCache, text: string, font: string, maxWidth: number, measure: TextMeasure): string {
  const key = `${font}|${Math.round(maxWidth)}|${text}`;
  return cache.fitted.get(key) ?? remember(cache.fitted, key, fitText(text, font, maxWidth, measure));
}

export interface ChatOverlayLayoutInput {
  /** Comments to show, oldest first (already privacy-filtered and sanitized). */
  comments: readonly ChatOverlayComment[];
  settings: ChatOverlayLayoutSettings;
  canvas: ChatOverlayCanvas;
  /** Output px kept free at the bottom for banners, tickers and lower thirds. */
  bottomInset: number;
  /** CSS font stack the overlay is set in. */
  fontFamily: string;
  measure: TextMeasure;
  cache?: ChatOverlayWrapCache;
}

interface PreparedRow {
  comment: ChatOverlayComment;
  author: string;
  lines: string[];
  height: number;
  pillWidth: number;
}

/**
 * Pure: where every card and every line of text goes. Newest comment at the
 * bottom, older ones stacked above it, anchored to the chosen side.
 */
export function layoutChatOverlay(input: ChatOverlayLayoutInput): ChatOverlayLayoutResult {
  const { comments, settings, canvas, bottomInset, fontFamily, measure } = input;
  const cache = input.cache ?? createChatOverlayWrapCache();
  const empty: ChatOverlayLayoutResult = { canvas, primitives: [], rows: [], bounds: null, omitted: 0 };
  if (comments.length === 0 || canvas.width <= 0 || canvas.height <= 0) return empty;

  const unit = Math.min(canvas.width, canvas.height) / 1080;
  const size = SIZE_SPEC[settings.size] ?? SIZE_SPEC.m;
  const shape = LAYOUT_SPEC[settings.layout] ?? LAYOUT_SPEC.regular;
  const margin = 40 * unit;
  const fontSize = size.font * unit;
  const authorSize = fontSize * 0.72;
  const pad = fontSize * 0.55;
  const accentWidth = fontSize * 0.2;
  const lineHeight = fontSize * 1.28;
  const authorLine = authorSize * 1.25;
  const gap = fontSize * 0.3;
  const cardWidth = Math.max(120 * unit, Math.min(size.width * shape.widthFactor * unit, canvas.width - margin * 2));
  const textWidth = cardWidth - pad * 2 - accentWidth;
  const maxHeight = canvas.height * shape.maxHeightFraction;
  const maxRows = getChatOverlayMaxRows(settings.layout);
  const bodyFont = chatOverlayFont(400, fontSize, fontFamily);
  const authorFont = chatOverlayFont(700, authorSize, fontFamily);
  const pillSize = authorSize * 0.78;
  const pillFont = chatOverlayFont(700, pillSize, fontFamily);
  const pillWidth = Math.ceil(measure(pillFont, QUESTION_LABEL)) + pillSize * 1.1;

  // Newest first: take comments while they fit the row and height budget.
  const prepared: PreparedRow[] = [];
  let used = 0;
  for (let index = comments.length - 1; index >= 0 && prepared.length < maxRows; index -= 1) {
    const comment = comments[index];
    const lines = wrapCached(cache, comment.text, bodyFont, textWidth, CHAT_OVERLAY_MAX_LINES, measure);
    if (lines.length === 0) continue;
    const labelWidth = comment.question ? pillWidth + authorSize * 0.5 : 0;
    const author = fitCached(cache, comment.author, authorFont, textWidth - labelWidth, measure);
    const height = pad + authorLine + fontSize * 0.12 + lines.length * lineHeight + pad * 0.85;
    const next = used + height + (prepared.length > 0 ? gap : 0);
    if (prepared.length > 0 && next > maxHeight) break;
    used = next;
    prepared.push({ comment, author, lines, height, pillWidth });
  }
  if (prepared.length === 0) return empty;

  const left = settings.side === 'right' ? canvas.width - margin - cardWidth : margin;
  let bottom = canvas.height - margin - Math.max(0, bottomInset);
  const primitives: ChatOverlayPrimitive[] = [];
  const rows: ChatOverlayRow[] = [];
  const radius = fontSize * 0.55;

  // prepared[0] is the newest and sits lowest.
  for (const row of prepared) {
    const top = bottom - row.height;
    const { comment } = row;
    primitives.push({ kind: 'rect', x: left, y: top, width: cardWidth, height: row.height, radius, fill: CHAT_OVERLAY_COLORS.card });
    primitives.push({
      kind: 'rect', x: left + pad * 0.5, y: top + pad * 0.7, width: accentWidth, height: row.height - pad * 1.4,
      radius: accentWidth / 2, fill: CHAT_OVERLAY_COLORS.accent[comment.source] ?? CHAT_OVERLAY_COLORS.accent.studio,
    });
    const textX = left + pad * 0.5 + accentWidth + pad * 0.7;
    const authorBaseline = top + pad + authorLine * 0.78;
    primitives.push({ kind: 'text', x: textX, y: authorBaseline, text: row.author, fontSize: authorSize, weight: 700, fill: CHAT_OVERLAY_COLORS.author });
    if (comment.question) {
      const pillX = textX + Math.ceil(measure(authorFont, row.author)) + authorSize * 0.5;
      const pillHeight = pillSize * 1.45;
      const pillY = authorBaseline - pillSize * 1.08;
      primitives.push({ kind: 'rect', x: pillX, y: pillY, width: row.pillWidth, height: pillHeight, radius: pillHeight / 2, fill: CHAT_OVERLAY_COLORS.questionFill });
      primitives.push({ kind: 'text', x: pillX + pillSize * 0.55, y: pillY + pillHeight * 0.72, text: QUESTION_LABEL, fontSize: pillSize, weight: 700, fill: CHAT_OVERLAY_COLORS.questionText });
    }
    const bodyTop = top + pad + authorLine + fontSize * 0.12;
    row.lines.forEach((line, lineIndex) => {
      primitives.push({ kind: 'text', x: textX, y: bodyTop + lineIndex * lineHeight + lineHeight * 0.76, text: line, fontSize, weight: 400, fill: CHAT_OVERLAY_COLORS.text });
    });
    rows.push({ id: comment.id, x: left, y: top, width: cardWidth, height: row.height, question: comment.question, lines: row.lines.length });
    bottom = top - gap;
  }
  rows.reverse();

  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    canvas,
    primitives,
    rows,
    bounds: { x: left, y: first.y, width: cardWidth, height: last.y + last.height - first.y },
    omitted: comments.length - prepared.length,
  };
}

/** Which stage overlays sit at the bottom and push the chat up (CSS px, as the stage lays them out). */
export interface ChatOverlayInsetFlags {
  banner: boolean;
  ticker: boolean;
  lowerThird: boolean;
}

/** Extra bottom clearance in stage CSS px; the caller scales it to output px. */
export function getChatOverlayInsetCss(flags: ChatOverlayInsetFlags): number {
  return Math.max(flags.ticker ? 44 : 0, flags.lowerThird ? 120 : 0, flags.banner ? 80 : 0);
}

/**
 * Remembers the last layout and recomputes only when an input changes
 * (comments and settings by reference, the rest by value).
 */
export function createChatOverlayLayoutCache() {
  const wrapCache = createChatOverlayWrapCache();
  let lastInput: ChatOverlayLayoutInput | null = null;
  let lastToken = '';
  let lastResult: ChatOverlayLayoutResult = { canvas: { width: 0, height: 0 }, primitives: [], rows: [], bounds: null, omitted: 0 };
  return {
    /** `token` changes when text metrics change (a font finished loading). */
    get(input: ChatOverlayLayoutInput, token = ''): ChatOverlayLayoutResult {
      const same = lastInput
        && lastToken === token
        && lastInput.comments === input.comments
        && lastInput.settings === input.settings
        && lastInput.canvas.width === input.canvas.width
        && lastInput.canvas.height === input.canvas.height
        && Math.round(lastInput.bottomInset) === Math.round(input.bottomInset)
        && lastInput.fontFamily === input.fontFamily;
      if (same) return lastResult;
      if (lastToken !== token) { wrapCache.lines.clear(); wrapCache.fitted.clear(); }
      lastInput = input;
      lastToken = token;
      lastResult = layoutChatOverlay({ ...input, cache: wrapCache });
      return lastResult;
    },
  };
}
