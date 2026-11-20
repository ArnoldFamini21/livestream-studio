import { createHmac, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  VIEWER_BLOCK_SCOPES,
  VIEWER_MESSAGE_MAX,
  VIEWER_NAME_MAX,
  VIEWER_QUESTION_MAX,
  RATE_MAX_TRACKED_KEYS,
  REQUEST_RATE_WINDOW_MS,
  VIEWER_REACTION_RULES,
  VIEWER_TALK_RULES,
  appendFeedMessage,
  appendFeedReaction,
  clearFeedMessages,
  createRateLimiterState,
  createRequestRateMeter,
  createViewerFeed,
  defaultViewerChatSwitches,
  isRepeatOfPrevious,
  isValidViewerId,
  isViewerReactionType,
  isWatchPublicStudioMessage,
  maskProfanity,
  noteRequest,
  normalizeViewerChatSwitchesPatch,
  readViewerFeed,
  removeFeedMessages,
  repeatKey,
  sanitizeViewerText,
  slowDownLine,
  suggestViewerPollMs,
  tryRecordAction,
  tryRecordKeyed,
  VIEWER_FULL_READ_RULE,
  VIEWER_LIVE_SMALL_ANSWER,
  type ChatMessage,
  type ChatReactionType,
  type QAQuestion,
  type RateRules,
  type ViewerBlockScope,
  type ViewerBlockSummary,
  type ViewerChatStatePayload,
  type ViewerChatSwitches,
  type ViewerFeedQuery,
  type WatchChatMessage,
  type WatchLiveResponse,
} from '@studio/shared';

/**
 * Viewer chat, reactions and questions from the public watch page.
 *
 * Viewers are anonymous and reach the server over plain HTTP, not the studio
 * connection. This module holds everything the server decides about them: the
 * three switches, the limits, the filter, the blocks and the feed that pages
 * read. It never logs, and the only things that leave it for a viewer are the
 * public message shape (name, text, time) and reaction counts. A viewer's id
 * and network key stay in here.
 *
 * What it needs from the studio (storing a chat message, telling screens) is
 * given to it as a `ViewerChatHost`, so the rules here can be tested alone.
 */

// ---------------------------------------------------------------------------
// The network key
// ---------------------------------------------------------------------------

/** Random for each server start: keys cannot be compared across restarts and the address cannot be recovered. */
const NETWORK_KEY_SALT = randomBytes(32);

/** Per minute, shared by everyone on one network. */
export const WATCH_LIVE_LIMIT_MAX = 2400;
const METER_READS_PER_NETWORK = WATCH_LIVE_LIMIT_MAX * REQUEST_RATE_WINDOW_MS / 60_000;

/**
 * A salted hash of the request address. Used to tell networks apart (limits,
 * blocks). The address itself is never stored or logged, and the key is never
 * sent to another viewer.
 */
export function networkKeyFor(address: string | undefined, salt: Buffer = NETWORK_KEY_SALT): string {
  return createHmac('sha256', salt).update(networkGroupOf(address)).digest('base64url').slice(0, 22);
}

/** The eight 16-bit groups of an IPv6 address (with "::" and a trailing IPv4 part understood), or null when it is not one. */
function expandIPv6(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes('.')) {
        if (index !== pieces.length - 1) return null;
        const octets = piece.split('.').map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : NaN));
        if (octets.length !== 4 || octets.some((octet) => !(octet >= 0 && octet <= 255))) return null;
        out.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * What counts as "the same network" for an address. An IPv4 address stands for
 * itself. A home or phone connection on IPv6 owns a whole /64 (every device and
 * every privacy address in it), so only the first 64 bits count; otherwise one
 * person could change address for each message and every limit and block
 * would miss them. An IPv4 address written as IPv6 (::ffff:1.2.3.4) counts as
 * the IPv4 address. Pure, so it can be tested alone.
 */
export function networkGroupOf(address: string | undefined): string {
  const text = (address || 'unknown').trim().toLowerCase().split('%')[0];
  if (!text.includes(':')) return text || 'unknown';
  const groups = expandIPv6(text);
  if (!groups) return text;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `v6:${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}`;
}

// ---------------------------------------------------------------------------
// Errors (the text is what a viewer reads)
// ---------------------------------------------------------------------------

export class ViewerChatError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

const LINES = {
  chatOff: 'Chat is turned off right now.',
  questionsOff: 'Questions are turned off right now.',
  reactionsOff: 'Reactions are turned off right now.',
  blocked: 'You can no longer post in this broadcast.',
  badViewer: 'Something went wrong with this page. Please reload it and try again.',
  nameTooLong: `Your name is too long. Please use ${VIEWER_NAME_MAX} characters or fewer.`,
  nameInvalid: 'Please check your name and try again.',
  messageTooLong: `Your message is too long. Please use ${VIEWER_MESSAGE_MAX} characters or fewer.`,
  questionTooLong: `Your question is too long. Please use ${VIEWER_QUESTION_MAX} characters or fewer.`,
  messageEmpty: 'Please write a message first.',
  questionEmpty: 'Please write your question first.',
  duplicate: 'You just sent that. Please write something new.',
  questionLimit: 'You already have questions waiting for the host. Please wait for an answer.',
  questionNetworkLimit: 'Many questions from your connection are waiting for the host. Please try again in a little while.',
  questionsFull: 'The list of questions is full right now. Please try again later.',
  badReaction: 'That reaction is not available.',
} as const;

// ---------------------------------------------------------------------------
// What the studio gives this module
// ---------------------------------------------------------------------------

export interface ViewerChatHost {
  /** A viewer's message becomes a studio chat message (an outside source) that every admitted person sees. */
  addChatMessage(message: ChatMessage): void;
  /** Takes messages out of the studio chat and tells every screen (the on-screen chat follows the chat list). */
  removeChatMessages(ids: readonly string[]): void;
  findChatMessage(id: string): ChatMessage | undefined;
  getChatMessages(): Iterable<ChatMessage>;
  addQuestion(question: QAQuestion): void;
  findQuestion(id: string): QAQuestion | undefined;
  getQuestions(): Iterable<QAQuestion>;
  /** Takes a blocked viewer's question off the queue and clears any highlight. */
  moderateQuestion(question: QAQuestion): void;
  /** Counts of reactions since the last call, for hosts and co-hosts. */
  sendReactionCounts(counts: Partial<Record<ChatReactionType, number>>): void;
  /** The switches and the blocked list changed. */
  sendState(state: ViewerChatStatePayload): void;
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

interface ViewerIdentity {
  handle: string;
  /** Last accepted text, bounded by the posting length limit. Its comparison form can be much longer. */
  lastText?: string;
}

interface ViewerPostOrigin {
  viewerId: string;
  networkKey: string;
}

// Object spreads preserve the posting network when a question or message
// changes. The symbol keeps the metadata out of every JSON response.
const VIEWER_POST_ORIGIN = Symbol('viewer post origin');
type StoredViewerPost = { id: string; [VIEWER_POST_ORIGIN]?: ViewerPostOrigin };

interface StoredBlock {
  id: string;
  scope: ViewerBlockScope;
  viewerId: string;
  networkKey?: string;
  name: string;
  blockedAt: string;
}

function matchesBlock(block: StoredBlock, origin: ViewerPostOrigin): boolean {
  return block.viewerId === origin.viewerId || block.networkKey === origin.networkKey;
}

/** Viewer handles and duplicate checks remembered per room. The oldest go first. */
const MAX_IDENTITIES = 3000;
/**
 * Questions one viewer may have waiting, one network may have waiting (a
 * congregation on one Wi-Fi, so generous; it also stops one person from using a
 * new viewer id for every question), and viewer questions open in the room.
 * Only questions still waiting count: when the host answers or dismisses them,
 * room opens up again.
 */
const MAX_WAITING_QUESTIONS_PER_VIEWER = 3;
const MAX_WAITING_QUESTIONS_PER_NETWORK = 15;
const MAX_OPEN_QUESTIONS_PER_ROOM = 200;
/** Longest studio line repeated on the watch page. */
const WATCH_STUDIO_TEXT_MAX = 500;
const REACTION_BATCH_MS = 500;
const VIEWER_SENDER_PREFIX = 'external:watch:';
const DEFAULT_VIEWER_NAME = 'Viewer';

export function viewerSenderId(handle: string): string {
  return `${VIEWER_SENDER_PREFIX}${handle}`;
}

export interface ViewerPostInput {
  viewerId?: unknown;
  name?: unknown;
  text?: unknown;
  reaction?: unknown;
}

export class ViewerChatRoom {
  private switches: ViewerChatSwitches = defaultViewerChatSwitches();
  private readonly feed = createViewerFeed(nanoid(8));
  private readonly talkLimits = createRateLimiterState();
  private readonly reactionLimits = createRateLimiterState();
  private readonly identities = new Map<string, ViewerIdentity>();
  private blocks: StoredBlock[] = [];
  /** When each network last got a big answer (the costly kind of read). */
  private readonly bigReads = new Map<string, number[]>();
  private readonly meter = createRequestRateMeter(0);
  private readonly meteredReads = new Map<string, number>();
  private meterStarted = false;
  private pendingReactions: Partial<Record<ChatReactionType, number>> = {};
  private reactionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: ViewerChatHost, private readonly rules: { talk: RateRules; reactions: RateRules } = { talk: VIEWER_TALK_RULES, reactions: VIEWER_REACTION_RULES }) {}

  // ----- What hosts and co-hosts see -----

  statePayload(): ViewerChatStatePayload {
    return {
      switches: { ...this.switches },
      blocks: this.blocks.map(({ id, scope, name, blockedAt }): ViewerBlockSummary => ({ id, scope, name, blockedAt })),
    };
  }

  getSwitches(): ViewerChatSwitches {
    return { ...this.switches };
  }

  /** A host's change to the switches. Returns false when the change held nothing usable. */
  applySwitches(rawPatch: unknown): boolean {
    const patch = normalizeViewerChatSwitchesPatch(rawPatch);
    if (!patch) return false;
    // Turning chat on starts the watch page list empty: nothing written while it was off (or before) is ever shown.
    if (patch.chat === true && !this.switches.chat) clearFeedMessages(this.feed);
    this.switches = { ...this.switches, ...patch };
    this.host.sendState(this.statePayload());
    return true;
  }

  // ----- The page asks -----

  /** The one small answer: switches, new messages, removals, reaction counts. */
  live(query: ViewerFeedQuery, now: number, networkKey = 'unknown', callInsEnabled = false): WatchLiveResponse {
    if (!this.meterStarted) {
      this.meter.windowStart = now;
      this.meterStarted = true;
    }
    const read = readViewerFeed(this.feed, query);
    const switches = { ...this.switches };
    // The place (epoch and cursor) is kept while chat is off, so reactions still reach pages; only the messages are held back.
    let messages = switches.chat ? read.messages : [];
    let removed = switches.chat ? read.removed : [];
    let reactions = switches.reactions ? read.reactions : {};
    let reset = read.reset;
    // A big answer is the costly read, whether the page has no place yet or asks from far back: one
    // network gets only so many a minute. Past that it gets the newest few as a fresh list, so a real
    // page still works and a script gets little. A page that keeps its place gets small answers and is
    // never held back.
    const big = messages.length > VIEWER_LIVE_SMALL_ANSWER;
    if (big && !tryRecordKeyed(this.bigReads, networkKey, now, VIEWER_FULL_READ_RULE).allowed) {
      messages = messages.slice(-VIEWER_LIVE_SMALL_ANSWER);
      removed = [];
      reactions = {};
      reset = true;
    }
    // Only ordinary small asks measure how busy the room is, so a stranger asking for big answers over
    // and over cannot make every real page slow down.
    const rate = big ? this.meter.rate : this.noteRead(networkKey, now);
    return {
      epoch: read.epoch,
      cursor: read.cursor,
      reset,
      switches,
      messages,
      removed,
      reactions,
      pollMs: suggestViewerPollMs(rate, switches.chat || switches.reactions || switches.questions || callInsEnabled),
    };
  }

  /** Count sustained demand across groups without letting one network's burst drive the room hint. */
  private noteRead(networkKey: string, now: number): number {
    if (now - this.meter.windowStart >= REQUEST_RATE_WINDOW_MS) this.meteredReads.clear();
    const reads = this.meteredReads.get(networkKey) ?? 0;
    if (reads >= METER_READS_PER_NETWORK || (reads === 0 && this.meteredReads.size >= RATE_MAX_TRACKED_KEYS)) {
      return this.meter.rate;
    }
    this.meteredReads.set(networkKey, reads + 1);
    return noteRequest(this.meter, now);
  }

  // ----- Viewers write -----

  postMessage(input: ViewerPostInput, networkKey: string, now: number): { message: WatchChatMessage } {
    if (!this.switches.chat) throw new ViewerChatError(LINES.chatOff, 403, 'CHAT_OFF');
    const viewerId = this.requireViewer(input.viewerId, networkKey);
    const name = this.cleanName(input.name);
    const text = this.cleanText(input.text, VIEWER_MESSAGE_MAX, LINES.messageTooLong, LINES.messageEmpty);
    this.refuseRepeat(this.identities.get(viewerId), text);
    this.spend(this.talkLimits, viewerId, networkKey, now, this.rules.talk);
    // Only a message that got through is remembered, so refused attempts cannot fill the memory.
    const identity = this.identityFor(viewerId);

    const id = nanoid(10);
    const message: WatchChatMessage = { id, from: 'viewer', name, text, at: now };
    identity.lastText = text;
    const origin = { viewerId, networkKey };
    const feedMessage = { ...message, [VIEWER_POST_ORIGIN]: origin };
    appendFeedMessage(this.feed, feedMessage);
    const studioMessage: ChatMessage & StoredViewerPost = {
      id,
      senderId: viewerSenderId(identity.handle),
      senderName: name,
      content: text,
      timestamp: new Date(now).toISOString(),
      isBackstage: false,
      source: { platform: 'watch', externalId: identity.handle, publishedAt: new Date(now).toISOString() },
      [VIEWER_POST_ORIGIN]: origin,
    };
    this.host.addChatMessage(studioMessage);
    return { message };
  }

  postQuestion(input: ViewerPostInput, networkKey: string, now: number): { questionId: string } {
    if (!this.switches.questions) throw new ViewerChatError(LINES.questionsOff, 403, 'QUESTIONS_OFF');
    const viewerId = this.requireViewer(input.viewerId, networkKey);
    const name = this.cleanName(input.name);
    const text = this.cleanText(input.text, VIEWER_QUESTION_MAX, LINES.questionTooLong, LINES.questionEmpty);
    const known = this.identities.get(viewerId);
    this.refuseRepeat(known, text);
    this.enforceQuestionLimits(viewerId, networkKey);
    this.spend(this.talkLimits, viewerId, networkKey, now, this.rules.talk);
    const identity = this.identityFor(viewerId);
    const authorId = viewerSenderId(identity.handle);

    identity.lastText = text;
    const question: QAQuestion & StoredViewerPost = {
      id: nanoid(10),
      authorId,
      authorName: name,
      content: text,
      timestamp: new Date(now).toISOString(),
      upvotes: 0,
      status: 'pending',
      highlighted: false,
      fromViewer: true,
      [VIEWER_POST_ORIGIN]: { viewerId, networkKey },
    };
    this.host.addQuestion(question);
    return { questionId: question.id };
  }

  postReaction(input: ViewerPostInput, networkKey: string, now: number): void {
    if (!this.switches.reactions) throw new ViewerChatError(LINES.reactionsOff, 403, 'REACTIONS_OFF');
    const viewerId = this.requireViewer(input.viewerId, networkKey);
    if (!isViewerReactionType(input.reaction)) throw new ViewerChatError(LINES.badReaction, 400, 'VALIDATION_ERROR');
    this.spend(this.reactionLimits, viewerId, networkKey, now, this.rules.reactions);
    appendFeedReaction(this.feed, input.reaction);
    this.pendingReactions[input.reaction] = (this.pendingReactions[input.reaction] ?? 0) + 1;
    if (!this.reactionTimer) {
      this.reactionTimer = setTimeout(() => this.flushReactions(), REACTION_BATCH_MS);
      this.reactionTimer.unref?.();
    }
  }

  /** Sends the reactions gathered so far to the studio as counts. Public so it can be called without waiting. */
  flushReactions(): void {
    if (this.reactionTimer) clearTimeout(this.reactionTimer);
    this.reactionTimer = undefined;
    const counts = this.pendingReactions;
    this.pendingReactions = {};
    if (Object.keys(counts).length > 0) this.host.sendReactionCounts(counts);
  }

  /** Stops any waiting timer (the room ended). */
  dispose(): void {
    if (this.reactionTimer) clearTimeout(this.reactionTimer);
    this.reactionTimer = undefined;
    this.pendingReactions = {};
  }

  // ----- The studio writes -----

  /** A message written in the studio: shown to viewers only when it is public (see `isWatchPublicStudioMessage`). */
  noteStudioMessage(message: ChatMessage, senderInGreenRoom: boolean, now: number): void {
    // Lines written while viewer chat is off are never shown to viewers later, so they are not kept for them.
    if (!this.switches.chat) return;
    if (!isWatchPublicStudioMessage(message, { senderInGreenRoom })) return;
    const text = this.studioText(message.content);
    if (!text) return;
    const name = this.studioName(message.senderName);
    appendFeedMessage(this.feed, { id: message.id, from: 'studio', name, text, at: Number.isFinite(Date.parse(message.timestamp)) ? Date.parse(message.timestamp) : now });
  }

  // ----- Moderation (host and co-host only; the caller checks that) -----

  /** Removes one viewer message everywhere. False when it is not a viewer message (or is already gone). */
  removeMessage(messageId: string): boolean {
    const inFeed = this.feed.messages.find((entry) => entry.id === messageId && entry.from === 'viewer');
    const inStudio = this.host.findChatMessage(messageId);
    if (!inFeed && inStudio?.source?.platform !== 'watch') return false;
    removeFeedMessages(this.feed, (entry) => entry.id === messageId && entry.from === 'viewer');
    this.host.removeChatMessages([messageId]);
    return true;
  }

  /**
   * Blocks the viewer who wrote `messageId` and, when requested, the network
   * they used for that post. Removes matching posts from chat and the Q&A queue.
   */
  blockViewer(messageId: string, scope: unknown, now: number): ViewerBlockSummary {
    if (!(VIEWER_BLOCK_SCOPES as readonly unknown[]).includes(scope)) throw new ViewerChatError('Choose who to block.', 400, 'VALIDATION_ERROR');
    const blockScope = scope as ViewerBlockScope;
    const target = this.findPost(messageId);
    if (!target) throw new ViewerChatError('That viewer can no longer be found. If they write again, block them from the new message.', 404, 'VIEWER_NOT_FOUND');

    const { viewerId } = target.origin;
    const networkKey = blockScope === 'network' ? target.origin.networkKey : undefined;
    let block = this.blocks.find((entry) => entry.viewerId === viewerId && entry.networkKey === networkKey);
    if (!block) {
      block = { id: nanoid(8), scope: blockScope, viewerId, networkKey, name: target.name, blockedAt: new Date(now).toISOString() };
      this.blocks.push(block);
    }
    this.purge(block);
    this.host.sendState(this.statePayload());
    return { id: block.id, scope: block.scope, name: block.name, blockedAt: block.blockedAt };
  }

  /** Lifts a block. Messages that were removed do not come back. */
  unblock(blockId: unknown): boolean {
    const before = this.blocks.length;
    this.blocks = this.blocks.filter((entry) => entry.id !== blockId);
    if (this.blocks.length === before) return false;
    this.host.sendState(this.statePayload());
    return true;
  }

  // ----- Inside -----

  private purge(block: StoredBlock): void {
    const matches = (post: StoredViewerPost) => {
      const origin = post[VIEWER_POST_ORIGIN];
      return origin !== undefined && matchesBlock(block, origin);
    };
    const ids = new Set(removeFeedMessages(this.feed, matches));
    for (const message of this.host.getChatMessages()) {
      if (matches(message)) ids.add(message.id);
    }
    if (ids.size > 0) this.host.removeChatMessages(Array.from(ids));
    for (const question of this.host.getQuestions()) {
      if (matches(question)) this.host.moderateQuestion(question);
    }
  }

  private findPost(id: string): { origin: ViewerPostOrigin; name: string } | undefined {
    const chat = this.host.findChatMessage(id);
    const feed = this.feed.messages.find((entry) => entry.id === id);
    const question = this.host.findQuestion(id);
    const posts: { post: StoredViewerPost | undefined; name: string | undefined }[] = [
      { post: chat, name: chat?.senderName },
      { post: feed, name: feed?.name },
      { post: question, name: question?.authorName },
    ];
    for (const { post, name } of posts) {
      const origin = post?.[VIEWER_POST_ORIGIN];
      if (origin && name !== undefined) return { origin, name };
    }
    return undefined;
  }

  private enforceQuestionLimits(viewerId: string, networkKey: string): void {
    let byViewer = 0;
    let byNetwork = 0;
    let open = 0;
    for (const question of this.host.getQuestions()) {
      if (question.status !== 'pending' && question.status !== 'approved') continue;
      const post: StoredViewerPost = question;
      const origin = post[VIEWER_POST_ORIGIN];
      if (!origin) continue;
      open += 1;
      if (origin.viewerId === viewerId) byViewer += 1;
      if (origin.networkKey === networkKey) byNetwork += 1;
    }
    if (byViewer >= MAX_WAITING_QUESTIONS_PER_VIEWER) throw new ViewerChatError(LINES.questionLimit, 429, 'QUESTION_LIMIT');
    if (byNetwork >= MAX_WAITING_QUESTIONS_PER_NETWORK) throw new ViewerChatError(LINES.questionNetworkLimit, 429, 'QUESTION_LIMIT');
    if (open >= MAX_OPEN_QUESTIONS_PER_ROOM) throw new ViewerChatError(LINES.questionsFull, 429, 'QUESTIONS_FULL');
  }

  /** Shares viewer blocks with other public audience actions. */
  requireViewer(viewerId: unknown, networkKey: string): string {
    if (!isValidViewerId(viewerId)) throw new ViewerChatError(LINES.badViewer, 400, 'VALIDATION_ERROR');
    const origin = { viewerId, networkKey };
    if (this.blocks.some((block) => matchesBlock(block, origin))) {
      throw new ViewerChatError(LINES.blocked, 403, 'VIEWER_BLOCKED');
    }
    return viewerId;
  }

  private cleanName(raw: unknown): string {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_VIEWER_NAME;
    const result = sanitizeViewerText(raw, VIEWER_NAME_MAX);
    if (!result.ok) {
      if (result.reason === 'empty') return DEFAULT_VIEWER_NAME;
      throw new ViewerChatError(result.reason === 'too-long' ? LINES.nameTooLong : LINES.nameInvalid, 400, 'VALIDATION_ERROR');
    }
    return maskProfanity(result.text).text;
  }

  private cleanText(raw: unknown, max: number, tooLong: string, empty: string): string {
    const result = sanitizeViewerText(raw, max);
    if (!result.ok) {
      throw new ViewerChatError(result.reason === 'too-long' ? tooLong : result.reason === 'empty' ? empty : LINES.messageEmpty, 400, 'VALIDATION_ERROR');
    }
    return maskProfanity(result.text).text;
  }

  private refuseRepeat(identity: ViewerIdentity | undefined, text: string): void {
    if (identity?.lastText !== undefined && isRepeatOfPrevious(repeatKey(identity.lastText), text)) {
      throw new ViewerChatError(LINES.duplicate, 409, 'DUPLICATE_MESSAGE');
    }
  }

  private spend(state: ReturnType<typeof createRateLimiterState>, viewerId: string, networkKey: string, now: number, rules: RateRules): void {
    const decision = tryRecordAction(state, { viewerId, networkKey }, now, rules);
    if (!decision.allowed) throw new ViewerChatError(slowDownLine(decision.retryAfterMs, decision.scope), 429, 'RATE_LIMITED', decision.retryAfterMs);
  }

  private identityFor(viewerId: string): ViewerIdentity {
    const existing = this.identities.get(viewerId);
    if (existing) return existing;
    if (this.identities.size >= MAX_IDENTITIES) {
      const oldest = this.identities.keys().next().value;
      if (oldest !== undefined) this.identities.delete(oldest);
    }
    const identity: ViewerIdentity = { handle: nanoid(8) };
    this.identities.set(viewerId, identity);
    return identity;
  }

  private studioName(raw: string): string {
    const clean = sanitizeViewerText(raw, 200);
    const base = clean.ok ? clean.text : 'Studio';
    return maskProfanity(Array.from(base).slice(0, VIEWER_NAME_MAX).join('')).text;
  }

  private studioText(raw: string): string {
    const clean = sanitizeViewerText(raw, 4000);
    if (!clean.ok) return '';
    const cut = Array.from(clean.text);
    const text = cut.length > WATCH_STUDIO_TEXT_MAX ? `${cut.slice(0, WATCH_STUDIO_TEXT_MAX - 1).join('').trimEnd()}…` : clean.text;
    return maskProfanity(text).text;
  }
}
