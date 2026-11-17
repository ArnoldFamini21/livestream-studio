/**
 * Viewer chat on the public watch page (P1.7): the rules shared by the server
 * (which enforces them) and the client (which shows what is allowed).
 *
 * Everything here is pure: no clock, no network, no storage. The clock is
 * always passed in, so every rule can be tested without waiting.
 *
 * Viewers are anonymous members of the public. Every piece of text they send
 * is untrusted: it is reduced to plain bounded text, run through the word
 * filter, and only then stored or shown anywhere.
 */
import type { ChatMessage, ChatReactionType } from './index.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const VIEWER_NAME_MAX = 40;
export const VIEWER_MESSAGE_MAX = 300;
export const VIEWER_QUESTION_MAX = 300;
/** Messages a watch page shows (and a fresh page loads). */
export const VIEWER_FEED_VISIBLE = 100;
/** Messages kept per room for late arrivals: about the last 200 from viewers, plus the studio's public lines. */
export const VIEWER_FEED_MESSAGES_MAX = 250;
export const VIEWER_FEED_REMOVALS_MAX = 200;
export const VIEWER_FEED_REACTIONS_MAX = 120;
/** A viewer's private id, made in the browser. */
export const VIEWER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** The studio-side body limit for every viewer POST. */
export const VIEWER_BODY_MAX_BYTES = 2048;

/** The reactions a viewer can send: the studio's own set, without the laughing face (a church broadcast). */
export const VIEWER_REACTION_TYPES = ['like', 'love', 'clap', 'wow'] as const satisfies readonly ChatReactionType[];
export type ViewerReactionType = typeof VIEWER_REACTION_TYPES[number];

export function isViewerReactionType(value: unknown): value is ViewerReactionType {
  return typeof value === 'string' && (VIEWER_REACTION_TYPES as readonly string[]).includes(value);
}

export function isValidViewerId(value: unknown): value is string {
  return typeof value === 'string' && VIEWER_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The three switches (all off until the host turns them on)
// ---------------------------------------------------------------------------

export interface ViewerChatSwitches {
  chat: boolean;
  reactions: boolean;
  questions: boolean;
}

export function defaultViewerChatSwitches(): ViewerChatSwitches {
  return { chat: false, reactions: false, questions: false };
}

export function normalizeViewerChatSwitches(raw: unknown): ViewerChatSwitches {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return { chat: value.chat === true, reactions: value.reactions === true, questions: value.questions === true };
}

/** A host's change: only real booleans count. Returns null when there is nothing usable. */
export function normalizeViewerChatSwitchesPatch(raw: unknown): Partial<ViewerChatSwitches> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const patch: Partial<ViewerChatSwitches> = {};
  for (const key of ['chat', 'reactions', 'questions'] as const) {
    if (typeof value[key] === 'boolean') patch[key] = value[key] as boolean;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// ---------------------------------------------------------------------------
// What the watch page and the studio send each other
// ---------------------------------------------------------------------------

/** One line in the watch-page chat. Never carries a viewer id, a network key or who moderated. */
export interface WatchChatMessage {
  id: string;
  /** `viewer`: written by a member of the public. `studio`: written by someone in the studio. */
  from: 'viewer' | 'studio';
  name: string;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}

/** The one answer the watch page asks for every few seconds. */
export interface WatchLiveResponse {
  epoch: string;
  cursor: number;
  /** The page must throw away what it has and use `messages` as the whole list. */
  reset: boolean;
  switches: ViewerChatSwitches;
  messages: WatchChatMessage[];
  removed: string[];
  /** Reactions since the cursor, as counts only. */
  reactions: Partial<Record<ViewerReactionType, number>>;
  /** How long the page should wait before asking again while the tab is visible. */
  pollMs: number;
}

export interface ViewerBlockSummary {
  id: string;
  scope: 'viewer' | 'network';
  /** The last name the blocked viewer used (what the host recognises). Never an id or a key. */
  name: string;
  blockedAt: string;
}

/** What hosts and co-hosts hold in the studio. */
export interface ViewerChatStatePayload {
  switches: ViewerChatSwitches;
  blocks: ViewerBlockSummary[];
}

export const VIEWER_BLOCK_SCOPES = ['viewer', 'network'] as const;
export type ViewerBlockScope = typeof VIEWER_BLOCK_SCOPES[number];

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

// C0 and C1 controls, DEL, soft hyphen, bidirectional controls, line and paragraph separators, zero-width
// characters, invisible "filler" letters that make a name look empty, noncharacters, and the tag block.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [[0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e], [0x200b, 0x200b], [0x200e, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x2800, 0x2800], [0x3164, 0x3164], [0xfe00, 0xfe0e], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xfffe, 0xffff], [0xe0000, 0xe007f]];
const codeEscape = (code: number) => `\\u{${code.toString(16)}}`;
/** A character class (u mode) for the given code point ranges. */
const rangeClass = (list: ReadonlyArray<readonly [number, number]>) => `[${list.map(([from, to]) => (from === to ? codeEscape(from) : `${codeEscape(from)}-${codeEscape(to)}`)).join('')}]`;
const UNSAFE_CHARS = new RegExp(rangeClass(UNSAFE_RANGES), 'gu');
/** Line and paragraph separators, and the next-line control, count as a space. */
const LINE_BREAKS = new RegExp(rangeClass([[0x85, 0x85], [0x2028, 0x2029]]), 'gu');
const JOINERS = new RegExp(rangeClass([[0x200c, 0x200d]]) + '+', 'gu');
/** Combining marks in a row beyond this many are dropped (stacked marks smear over other lines). */
export const VIEWER_MAX_COMBINING_MARKS = 4;
const MARK_RUN = /\p{M}{5,}/gu;
const VISIBLE = new RegExp('[^\\s\\p{M}' + codeEscape(0x200c) + codeEscape(0x200d) + ']', 'u');

function capMarkRun(run: string): string {
  return Array.from(run).slice(0, VIEWER_MAX_COMBINING_MARKS).join('');
}

/** Joiners stay only between two visible characters (emoji sequences, some scripts); elsewhere they are invisible clutter. */
function keepUsefulJoiners(text: string): string {
  return text.replace(JOINERS, (run, offset: number) => {
    const before = text[offset - 1];
    const after = text[offset + run.length];
    return before && after && !/\s/u.test(before) && !/\s/u.test(after) ? run[0] : '';
  });
}

export type ViewerTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-text' | 'empty' | 'too-long' };

/**
 * Plain, single-line text of at most `maxLength` characters (code points).
 * Never returns control or direction-changing characters. Text that is too
 * long is refused, not cut: the person is told, and nothing half-sent appears.
 */
export function sanitizeViewerText(value: unknown, maxLength: number): ViewerTextResult {
  if (typeof value !== 'string') return { ok: false, reason: 'not-text' };
  // Never work on a huge input: even with generous spacing a valid text is far shorter.
  if (value.length > maxLength * 8) return { ok: false, reason: 'too-long' };
  const flat = keepUsefulJoiners(value.normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(LINE_BREAKS, ' ').replace(UNSAFE_CHARS, ''))
    .replace(/\s+/gu, ' ')
    .replace(MARK_RUN, capMarkRun)
    .trim();
  if (!flat || !VISIBLE.test(flat)) return { ok: false, reason: 'empty' };
  if (Array.from(flat).length > maxLength) return { ok: false, reason: 'too-long' };
  return { ok: true, text: flat };
}

/** A comparison form for "the same message twice": case, spacing and trailing punctuation do not make a new message. */
export function repeatKey(text: string): string {
  const letters = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Only emoji or punctuation: compare what was typed.
  return letters || text.trim().toLowerCase();
}

/** True when `next` says the same as the viewer's previous accepted message (`previousKey` is its `repeatKey`). */
export function isRepeatOfPrevious(previousKey: string | undefined, next: string): boolean {
  return previousKey !== undefined && previousKey !== '' && repeatKey(next) === previousKey;
}

// ---------------------------------------------------------------------------
// The word filter (English and Tagalog)
// ---------------------------------------------------------------------------

/**
 * A short list of words that are not wanted in a church broadcast, matched as
 * whole words. It leaves out words with an ordinary or biblical use (hell,
 * damn, ass, cock, whore, bastard, dick) and words that are ordinary in a
 * Philippine church (leche flan, a Latin "cum", the singer Gaga, "mf" in music).
 * It is a speed bump, not a promise:
 * the host's blocking and removal are the real protection.
 */
const BLOCKED_WORDS: readonly string[] = [
  // English
  'fuck', 'fucks', 'fucker', 'fuckers', 'fucking', 'fucked', 'fuckin', 'motherfucker', 'motherfuckers',
  'shit', 'shits', 'shitty', 'shitting', 'bullshit', 'shithead', 'bitch', 'bitches', 'bitchy',
  'asshole', 'assholes', 'dickhead', 'cunt', 'cunts', 'pussy', 'slut', 'sluts', 'twat', 'wanker',
  'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'fag', 'chink', 'spic', 'kike', 'tranny',
  'retard', 'retarded', 'porn', 'porno', 'blowjob', 'handjob', 'jizz', 'whorehouse',
  // Tagalog
  'putang', 'putangina', 'putanginamo', 'potangina', 'puta', 'tangina', 'tanginamo', 'tarantado', 'gago',
  'ulol', 'bobo', 'tanga', 'lintik', 'punyeta', 'pakyu', 'pakshet', 'kantot', 'kantutan', 'puki',
  'pukinangina', 'burat', 'jakol', 'kupal', 'hindot', 'bwisit', 'buwisit', 'inutil', 'shunga', 'tamod',
];
const BLOCKED_SET = new Set(BLOCKED_WORDS);

const LOOKALIKES: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't' };
// Letters from other alphabets that look like Latin ones.
const OTHER_ALPHABETS: Record<string, string> = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b' };
// A zero-width joiner or non-joiner inside a word (kept by the text clean-up between letters) is part of the word, not a gap.
const WORD_PARTS = new RegExp('[\\p{L}\\p{N}\\p{M}@$!|+＠＄！｜＋' + codeEscape(0x200c) + codeEscape(0x200d) + ']+', 'gu');
const EDGE_SYMBOLS_END = /[@$!|+＠＄！｜＋]+$/u;
const EDGE_SYMBOLS_START = /^[@$!|+＠＄！｜＋]+/u;

/** Letters only in a plain lower-case form: accents, full-width and look-alike letters are folded. */
function foldWord(word: string): string {
  const base = word.normalize('NFKD').replace(/\p{M}/gu, '').replace(JOINERS, '').toLowerCase();
  let out = '';
  for (const char of base) out += OTHER_ALPHABETS[char] ?? char;
  return out;
}

function mapLookalikes(folded: string): string {
  let out = '';
  for (const char of folded) out += LOOKALIKES[char] ?? char;
  return out;
}

/** The forms a stretched word may take: "fuuuck" and "fuuck" are "fuck"; "assss" is "ass". */
function stretchForms(word: string): string[] {
  return [
    word,
    word.replace(/(.)\1{2,}/gu, '$1'),
    word.replace(/(.)\1{2,}/gu, '$1$1'),
    word.replace(/(.)\1+/gu, '$1'),
  ];
}

function isBlockedForm(form: string): boolean {
  if (!form) return false;
  return stretchForms(form).some((variant) => BLOCKED_SET.has(variant));
}

/**
 * Does this word (as typed) match the list? `coreStart` and `coreEnd` are the
 * part to mask, in the typed word, so a trailing "!" stays a "!".
 */
function matchWord(typed: string): { coreStart: number; coreEnd: number } | null {
  const folded = foldWord(typed);
  // Only words with at least one real letter are read through look-alikes: "455" is a number.
  if (!/\p{L}/u.test(folded)) return null;
  if (isBlockedForm(mapLookalikes(folded))) return { coreStart: 0, coreEnd: typed.length };
  const trailing = typed.match(EDGE_SYMBOLS_END)?.[0].length ?? 0;
  const afterTrailing = typed.slice(0, typed.length - trailing);
  if (trailing > 0 && isBlockedForm(mapLookalikes(foldWord(afterTrailing)))) {
    return { coreStart: 0, coreEnd: afterTrailing.length };
  }
  const leading = afterTrailing.match(EDGE_SYMBOLS_START)?.[0].length ?? 0;
  if (leading > 0) {
    const core = afterTrailing.slice(leading);
    if (isBlockedForm(mapLookalikes(foldWord(core)))) return { coreStart: leading, coreEnd: afterTrailing.length };
  }
  return null;
}

/** Masks listed words with asterisks (same length), keeping everything else. Nothing is dropped. */
export function maskProfanity(text: string): { text: string; masked: boolean } {
  let masked = false;
  const out = text.replace(WORD_PARTS, (word) => {
    const hit = matchWord(word);
    if (!hit) return word;
    masked = true;
    const before = word.slice(0, hit.coreStart);
    const core = word.slice(hit.coreStart, hit.coreEnd);
    const after = word.slice(hit.coreEnd);
    return `${before}${'*'.repeat(Array.from(core).length)}${after}`;
  });
  return { text: out, masked };
}

// ---------------------------------------------------------------------------
// Limits per viewer, per network and per room
// ---------------------------------------------------------------------------

export interface RateRule {
  /** Least time between two accepted actions (0: none). */
  minGapMs: number;
  /** Most accepted actions inside `windowMs`. */
  max: number;
  windowMs: number;
}

export interface RateRules {
  viewer: RateRule;
  network: RateRule;
  room: RateRule;
}

/**
 * Chat messages and questions. The per-viewer rule is strict. The network rule
 * is generous on purpose: a whole congregation can sit behind one church
 * Wi-Fi. The room ceiling stops a flood from many addresses at once.
 */
export const VIEWER_TALK_RULES: RateRules = {
  viewer: { minGapMs: 2000, max: 5, windowMs: 30_000 },
  network: { minGapMs: 0, max: 30, windowMs: 30_000 },
  room: { minGapMs: 0, max: 120, windowMs: 30_000 },
};

/** Reactions are quick taps, so the viewer gap is short; the ceilings still bound the flood. */
export const VIEWER_REACTION_RULES: RateRules = {
  viewer: { minGapMs: 400, max: 20, windowMs: 30_000 },
  network: { minGapMs: 0, max: 300, windowMs: 30_000 },
  room: { minGapMs: 0, max: 600, windowMs: 30_000 },
};

export interface RateLimiterState {
  viewers: Map<string, number[]>;
  networks: Map<string, number[]>;
  room: number[];
}

export function createRateLimiterState(): RateLimiterState {
  return { viewers: new Map(), networks: new Map(), room: [] };
}

export type RateDecision =
  | { allowed: true }
  | { allowed: false; scope: 'viewer' | 'network' | 'room'; retryAfterMs: number };

/** Only accepted actions are remembered, so the maps stay small; this bounds them even so. */
export const RATE_MAX_TRACKED_KEYS = 5000;

function recent(history: readonly number[] | undefined, now: number, windowMs: number): number[] {
  if (!history || history.length === 0) return [];
  return history.filter((at) => at > now - windowMs && at <= now);
}

/** Pure check of one rule against a history (oldest first). */
export function checkRateRule(history: readonly number[] | undefined, now: number, rule: RateRule): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const inWindow = recent(history, now, rule.windowMs);
  let wait = 0;
  if (rule.minGapMs > 0 && inWindow.length > 0) {
    wait = Math.max(wait, inWindow[inWindow.length - 1] + rule.minGapMs - now);
  }
  if (inWindow.length >= rule.max) {
    wait = Math.max(wait, inWindow[inWindow.length - rule.max] + rule.windowMs - now);
  }
  return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true };
}

function remember(map: Map<string, number[]>, key: string, now: number, windowMs: number): void {
  const history = recent(map.get(key), now, windowMs);
  history.push(now);
  if (map.has(key)) map.delete(key);
  else if (map.size >= RATE_MAX_TRACKED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, history);
}

/**
 * Checks the viewer, the network and the room rules together and, only when
 * all three allow it, records the action. A refused attempt costs nothing, so
 * waiting is always enough.
 */
export function tryRecordAction(
  state: RateLimiterState,
  who: { viewerId: string; networkKey: string },
  now: number,
  rules: RateRules,
): RateDecision {
  const checks: Array<['viewer' | 'network' | 'room', ReturnType<typeof checkRateRule>]> = [
    ['viewer', checkRateRule(state.viewers.get(who.viewerId), now, rules.viewer)],
    ['network', checkRateRule(state.networks.get(who.networkKey), now, rules.network)],
    ['room', checkRateRule(state.room, now, rules.room)],
  ];
  let worst: RateDecision = { allowed: true };
  for (const [scope, result] of checks) {
    if (!result.allowed && (worst.allowed || result.retryAfterMs > worst.retryAfterMs)) {
      worst = { allowed: false, scope, retryAfterMs: result.retryAfterMs };
    }
  }
  if (!worst.allowed) return worst;
  remember(state.viewers, who.viewerId, now, rules.viewer.windowMs);
  remember(state.networks, who.networkKey, now, rules.network.windowMs);
  state.room = recent(state.room, now, rules.room.windowMs);
  state.room.push(now);
  return worst;
}

/**
 * Checks one rule for one key in a bounded history map and, when it allows the
 * action, records it. A refused attempt costs nothing. Used for the reads that
 * cost the server real work (see `VIEWER_FULL_READ_RULE`).
 */
export function tryRecordKeyed(map: Map<string, number[]>, key: string, now: number, rule: RateRule): RateDecision {
  const result = checkRateRule(map.get(key), now, rule);
  if (!result.allowed) return { allowed: false, scope: 'network', retryAfterMs: result.retryAfterMs };
  remember(map, key, now, rule.windowMs);
  return { allowed: true };
}

/** The plain line a viewer reads when asked to slow down. */
export function slowDownLine(retryAfterMs: number, scope: 'viewer' | 'network' | 'room' = 'viewer'): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  // The limit of a whole network or room is not the viewer's doing: do not make it sound like their fault.
  if (scope !== 'viewer') {
    return seconds === 1
      ? 'Chat is busy right now. Please try again in 1 second.'
      : `Chat is busy right now. Please try again in ${seconds} seconds.`;
  }
  return seconds === 1
    ? 'Please slow down. You can send again in 1 second.'
    : `Please slow down. You can send again in ${seconds} seconds.`;
}

// ---------------------------------------------------------------------------
// Which studio messages the watch page may show
// ---------------------------------------------------------------------------

/**
 * The one rule for "public chat": not backstage and not a private message.
 * The on-screen chat overlay and the watch page both use it.
 */
export function isPublicChatCandidate(message: Pick<ChatMessage, 'isBackstage' | 'recipientId'>): boolean {
  return !message.isBackstage && !message.recipientId;
}

/**
 * A studio message the watch page may show. The on-screen overlay's rule
 * (public, and not from someone still in the green room) plus one more: the
 * message was written in the studio itself. Comments imported from YouTube or
 * Facebook, and viewers' own messages (they have their own entry), are not
 * repeated to this audience.
 */
export function isWatchPublicStudioMessage(
  message: Pick<ChatMessage, 'isBackstage' | 'recipientId' | 'source'>,
  context: { senderInGreenRoom: boolean },
): boolean {
  return isPublicChatCandidate(message) && !context.senderInGreenRoom && !message.source;
}

// ---------------------------------------------------------------------------
// The feed: what the watch page asks for, with a cursor
// ---------------------------------------------------------------------------

export interface ViewerFeedMessage extends WatchChatMessage {
  seq: number;
  /** Server-only handle of the viewer who wrote it (for removal by viewer). Never sent. */
  ref?: string;
}

export interface ViewerFeed {
  /** Changes when the feed starts over (a restart), so an old cursor is never trusted. */
  epoch: string;
  seq: number;
  /** The highest change number that may no longer be available. */
  lostBelow: number;
  messages: ViewerFeedMessage[];
  removals: Array<{ seq: number; id: string }>;
  reactions: Array<{ seq: number; type: ViewerReactionType }>;
}

export function createViewerFeed(epoch: string): ViewerFeed {
  return { epoch, seq: 0, lostBelow: 0, messages: [], removals: [], reactions: [] };
}

export function appendFeedMessage(feed: ViewerFeed, message: Omit<ViewerFeedMessage, 'seq'>): ViewerFeedMessage {
  const entry: ViewerFeedMessage = { ...message, seq: ++feed.seq };
  feed.messages.push(entry);
  while (feed.messages.length > VIEWER_FEED_MESSAGES_MAX) {
    const dropped = feed.messages.shift();
    if (dropped) feed.lostBelow = Math.max(feed.lostBelow, dropped.seq);
  }
  return entry;
}

/** Takes the messages matching `shouldRemove` out of the feed and tells pages that already have them. Returns the ids. */
export function removeFeedMessages(feed: ViewerFeed, shouldRemove: (message: ViewerFeedMessage) => boolean): string[] {
  const removedIds: string[] = [];
  feed.messages = feed.messages.filter((message) => {
    if (!shouldRemove(message)) return true;
    removedIds.push(message.id);
    return false;
  });
  for (const id of removedIds) {
    feed.removals.push({ seq: ++feed.seq, id });
  }
  while (feed.removals.length > VIEWER_FEED_REMOVALS_MAX) {
    const dropped = feed.removals.shift();
    if (dropped) feed.lostBelow = Math.max(feed.lostBelow, dropped.seq);
  }
  return removedIds;
}

/**
 * Empties the list of messages (the host switched chat on again). The step in
 * the numbering makes every page that holds an older place start over with
 * the fresh, empty list, so nothing written while chat was off ever shows.
 */
export function clearFeedMessages(feed: ViewerFeed): void {
  feed.messages = [];
  feed.removals = [];
  feed.seq += 1;
  feed.lostBelow = feed.seq;
}

export function appendFeedReaction(feed: ViewerFeed, type: ViewerReactionType): void {
  feed.reactions.push({ seq: ++feed.seq, type });
  if (feed.reactions.length > VIEWER_FEED_REACTIONS_MAX) feed.reactions.shift();
}

/** A page's request: both parts come from the address and may be anything. */
export interface ViewerFeedQuery {
  after?: unknown;
  epoch?: unknown;
}

function toWire(message: ViewerFeedMessage): WatchChatMessage {
  return { id: message.id, from: message.from, name: message.name, text: message.text, at: message.at };
}

export interface ViewerFeedRead {
  epoch: string;
  cursor: number;
  reset: boolean;
  messages: WatchChatMessage[];
  removed: string[];
  reactions: Partial<Record<ViewerReactionType, number>>;
}

/**
 * What a page that holds everything up to `after` is missing. A page that
 * asks with another epoch, a cursor from the future, a cursor older than what
 * is kept, or that is more than a screenful behind gets a fresh list (`reset`).
 */
export function readViewerFeed(feed: ViewerFeed, query: ViewerFeedQuery): ViewerFeedRead {
  const afterNumber = typeof query.after === 'string' && /^\d{1,15}$/.test(query.after) ? Number(query.after) : typeof query.after === 'number' && Number.isSafeInteger(query.after) && query.after >= 0 ? query.after : null;
  const sameEpoch = query.epoch === feed.epoch;
  let reset = !sameEpoch || afterNumber === null || afterNumber > feed.seq || afterNumber < feed.lostBelow;
  let newMessages: ViewerFeedMessage[] = [];
  if (!reset && afterNumber !== null) {
    newMessages = feed.messages.filter((message) => message.seq > afterNumber);
    if (newMessages.length > VIEWER_FEED_VISIBLE) reset = true;
  }
  if (reset) {
    const latest = feed.messages.slice(-VIEWER_FEED_VISIBLE);
    return { epoch: feed.epoch, cursor: feed.seq, reset: true, messages: latest.map(toWire), removed: [], reactions: {} };
  }
  const after = afterNumber ?? 0;
  const reactions: Partial<Record<ViewerReactionType, number>> = {};
  for (const entry of feed.reactions) {
    if (entry.seq > after) reactions[entry.type] = (reactions[entry.type] ?? 0) + 1;
  }
  return {
    epoch: feed.epoch,
    cursor: feed.seq,
    reset: false,
    messages: newMessages.map(toWire),
    removed: feed.removals.filter((entry) => entry.seq > after).map((entry) => entry.id),
    reactions,
  };
}

// ---------------------------------------------------------------------------
// How often a page asks (the server can ask pages to ease off)
// ---------------------------------------------------------------------------

export const VIEWER_POLL_MS_DEFAULT = 4000;
/** While all three switches are off a page has nothing to show, so it asks this seldom (it still notices a switch within this time). */
export const VIEWER_POLL_MS_IDLE = 20_000;
/**
 * A page that asks for the whole recent list (it has no place yet) costs the
 * server real work and up to ~40 kB. One address may do this this often: a
 * whole congregation can open the page together on one Wi-Fi, a script cannot.
 */
export const VIEWER_FULL_READ_RULE: RateRule = { minGapMs: 0, max: 120, windowMs: 60_000 };
/** A hidden tab asks this seldom at the most often. */
export const VIEWER_POLL_MS_HIDDEN_MIN = 15_000;

/**
 * The wait the server suggests, given how many requests per second the room is
 * getting, and whether any switch is on (with all three off there is nothing to
 * show, so pages ask slowly).
 */
export function suggestViewerPollMs(requestsPerSecond: number, anySwitchOn = true): number {
  if (!anySwitchOn) return VIEWER_POLL_MS_IDLE;
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 40) return VIEWER_POLL_MS_DEFAULT;
  if (requestsPerSecond <= 100) return 6000;
  if (requestsPerSecond <= 250) return 10_000;
  return 15_000;
}

/** The wait the page uses: the server's hint while visible, much slower while the tab is hidden. */
export function effectiveViewerPollMs(serverHintMs: number | undefined, hidden: boolean): number {
  const hint = typeof serverHintMs === 'number' && Number.isFinite(serverHintMs)
    ? Math.min(30_000, Math.max(2000, serverHintMs))
    : VIEWER_POLL_MS_DEFAULT;
  return hidden ? Math.max(VIEWER_POLL_MS_HIDDEN_MIN, hint * 3) : hint;
}

/** A rolling count of requests: `rate` is the average per second over the last full window. */
export interface RequestRateMeter {
  windowStart: number;
  count: number;
  rate: number;
}

export const REQUEST_RATE_WINDOW_MS = 10_000;

export function createRequestRateMeter(now: number): RequestRateMeter {
  return { windowStart: now, count: 0, rate: 0 };
}

/** Counts one request and returns the current rate estimate. */
export function noteRequest(meter: RequestRateMeter, now: number): number {
  const elapsed = now - meter.windowStart;
  if (elapsed >= REQUEST_RATE_WINDOW_MS) {
    // A quiet stretch counts as quiet: a window longer than expected spreads the count over its real length.
    meter.rate = meter.count / (elapsed / 1000);
    meter.windowStart = now;
    meter.count = 0;
  }
  meter.count += 1;
  return meter.rate;
}
