import { createHmac, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  VIEWER_BLOCK_SCOPES,
  VIEWER_MESSAGE_MAX,
  VIEWER_NAME_MAX,
  VIEWER_QUESTION_MAX,
  VIEWER_REACTION_RULES,
  VIEWER_TALK_RULES,
  appendFeedMessage,
  appendFeedReaction,
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

/**
 * A salted hash of the request address. Used to tell networks apart (limits,
 * blocks). The address itself is never stored or logged, and the key is never
 * sent to another viewer.
 */
export function networkKeyFor(address: string | undefined, salt: Buffer = NETWORK_KEY_SALT): string {
  return createHmac('sha256', salt).update(address || 'unknown').digest('base64url').slice(0, 22);
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
  /** Ids of the studio chat messages written by any of these senders. */
  chatMessageIdsBySender(senderIds: ReadonlySet<string>): string[];
  addQuestion(question: QAQuestion): void;
  /** Questions from this viewer still waiting, and all viewer questions in the room. */
  countViewerQuestions(authorId: string): { waiting: number; total: number };
  /** Takes a blocked viewer's questions that are not yet answered off the queue. */
  dismissViewerQuestions(authorIds: ReadonlySet<string>): void;
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
  viewerId: string;
  networkKey: string;
  name: string;
  /** What the viewer last said (comparison form), so the same message twice in a row is refused. */
  lastKey?: string;
}

interface StoredBlock {
  id: string;
  scope: ViewerBlockScope;
  /** The viewer id, or the network key. Never leaves the server. */
  key: string;
  name: string;
  blockedAt: string;
}

/** People remembered per room (so a message can be traced back to its writer). The oldest go first. */
const MAX_IDENTITIES = 3000;
/** Questions one viewer may have waiting, and all viewer questions in a room. */
const MAX_WAITING_QUESTIONS_PER_VIEWER = 3;
const MAX_VIEWER_QUESTIONS_PER_ROOM = 200;
/** Longest studio line repeated on the watch page. */
const WATCH_STUDIO_TEXT_MAX = 500;
const REACTION_BATCH_MS = 500;
const VIEWER_SENDER_PREFIX = 'external:watch:';
const DEFAULT_VIEWER_NAME = 'Viewer';

export function viewerSenderId(handle: string): string {
  return `${VIEWER_SENDER_PREFIX}${handle}`;
}

function handleFromSenderId(senderId: string): string | null {
  return senderId.startsWith(VIEWER_SENDER_PREFIX) ? senderId.slice(VIEWER_SENDER_PREFIX.length) : null;
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
  private readonly handleByViewerId = new Map<string, string>();
  private blocks: StoredBlock[] = [];
  private readonly meter = createRequestRateMeter(0);
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
    this.switches = { ...this.switches, ...patch };
    this.host.sendState(this.statePayload());
    return true;
  }

  // ----- The page asks -----

  /** The one small answer: switches, new messages, removals, reaction counts. */
  live(query: ViewerFeedQuery, now: number): WatchLiveResponse {
    if (!this.meterStarted) {
      this.meter.windowStart = now;
      this.meterStarted = true;
    }
    const rate = noteRequest(this.meter, now);
    const read = readViewerFeed(this.feed, query);
    const switches = { ...this.switches };
    return {
      epoch: read.epoch,
      cursor: read.cursor,
      // With chat off the page shows nothing and forgets its list: it starts fresh when chat is turned back on.
      reset: switches.chat ? read.reset : true,
      switches,
      messages: switches.chat ? read.messages : [],
      removed: switches.chat ? read.removed : [],
      reactions: switches.reactions ? read.reactions : {},
      pollMs: suggestViewerPollMs(rate),
    };
  }

  // ----- Viewers write -----

  postMessage(input: ViewerPostInput, networkKey: string, now: number): { message: WatchChatMessage } {
    if (!this.switches.chat) throw new ViewerChatError(LINES.chatOff, 403, 'CHAT_OFF');
    const viewerId = this.requireViewer(input.viewerId, networkKey);
    const name = this.cleanName(input.name);
    const text = this.cleanText(input.text, VIEWER_MESSAGE_MAX, LINES.messageTooLong, LINES.messageEmpty);
    this.refuseRepeat(this.peekIdentity(viewerId), text);
    this.spend(this.talkLimits, viewerId, networkKey, now, this.rules.talk);
    // Only a message that got through is remembered, so refused attempts cannot fill the memory.
    const identity = this.identityFor(viewerId, networkKey, name);

    const id = nanoid(10);
    const message: WatchChatMessage = { id, from: 'viewer', name, text, at: now };
    identity.lastKey = repeatKey(text);
    appendFeedMessage(this.feed, { ...message, ref: identity.handle });
    this.host.addChatMessage({
      id,
      senderId: viewerSenderId(identity.handle),
      senderName: name,
      content: text,
      timestamp: new Date(now).toISOString(),
      isBackstage: false,
      source: { platform: 'watch', externalId: identity.handle, publishedAt: new Date(now).toISOString() },
    });
    return { message };
  }

  postQuestion(input: ViewerPostInput, networkKey: string, now: number): { questionId: string } {
    if (!this.switches.questions) throw new ViewerChatError(LINES.questionsOff, 403, 'QUESTIONS_OFF');
    const viewerId = this.requireViewer(input.viewerId, networkKey);
    const name = this.cleanName(input.name);
    const text = this.cleanText(input.text, VIEWER_QUESTION_MAX, LINES.questionTooLong, LINES.questionEmpty);
    const known = this.peekIdentity(viewerId);
    this.refuseRepeat(known, text);
    const counts = this.host.countViewerQuestions(known ? viewerSenderId(known.handle) : '');
    if (counts.waiting >= MAX_WAITING_QUESTIONS_PER_VIEWER) throw new ViewerChatError(LINES.questionLimit, 429, 'QUESTION_LIMIT');
    if (counts.total >= MAX_VIEWER_QUESTIONS_PER_ROOM) throw new ViewerChatError(LINES.questionsFull, 429, 'QUESTIONS_FULL');
    this.spend(this.talkLimits, viewerId, networkKey, now, this.rules.talk);
    const identity = this.identityFor(viewerId, networkKey, name);
    const authorId = viewerSenderId(identity.handle);

    identity.lastKey = repeatKey(text);
    const question: QAQuestion = {
      id: nanoid(10),
      authorId,
      authorName: name,
      content: text,
      timestamp: new Date(now).toISOString(),
      upvotes: 0,
      status: 'pending',
      highlighted: false,
      fromViewer: true,
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
   * Blocks the viewer who wrote `messageId`, alone or with everyone on the same
   * network, and removes their earlier messages and unanswered questions.
   */
  blockViewer(messageId: string, scope: unknown, now: number): ViewerBlockSummary {
    if (!(VIEWER_BLOCK_SCOPES as readonly unknown[]).includes(scope)) throw new ViewerChatError('Choose who to block.', 400, 'VALIDATION_ERROR');
    const blockScope = scope as ViewerBlockScope;
    const handle = this.handleOfMessage(messageId);
    const identity = handle ? this.identities.get(handle) : undefined;
    if (!identity) throw new ViewerChatError('That viewer can no longer be found. If they write again, block them from the new message.', 404, 'VIEWER_NOT_FOUND');

    const key = blockScope === 'viewer' ? identity.viewerId : identity.networkKey;
    let block = this.blocks.find((entry) => entry.scope === blockScope && entry.key === key);
    if (!block) {
      block = { id: nanoid(8), scope: blockScope, key, name: identity.name, blockedAt: new Date(now).toISOString() };
      this.blocks.push(block);
    }
    this.purge(blockScope, key);
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

  private purge(scope: ViewerBlockScope, key: string): void {
    const handles = new Set<string>();
    for (const identity of this.identities.values()) {
      if ((scope === 'viewer' ? identity.viewerId : identity.networkKey) === key) handles.add(identity.handle);
    }
    if (handles.size === 0) return;
    const senderIds = new Set(Array.from(handles, viewerSenderId));
    const removedFromFeed = removeFeedMessages(this.feed, (entry) => entry.ref !== undefined && handles.has(entry.ref));
    const ids = new Set([...removedFromFeed, ...this.host.chatMessageIdsBySender(senderIds)]);
    if (ids.size > 0) this.host.removeChatMessages(Array.from(ids));
    this.host.dismissViewerQuestions(senderIds);
  }

  private handleOfMessage(messageId: string): string | null {
    const studio = this.host.findChatMessage(messageId);
    if (studio?.source?.platform === 'watch') return handleFromSenderId(studio.senderId);
    const entry = this.feed.messages.find((item) => item.id === messageId && item.from === 'viewer');
    return entry?.ref ?? null;
  }

  private requireViewer(viewerId: unknown, networkKey: string): string {
    if (!isValidViewerId(viewerId)) throw new ViewerChatError(LINES.badViewer, 400, 'VALIDATION_ERROR');
    if (this.blocks.some((block) => (block.scope === 'viewer' ? block.key === viewerId : block.key === networkKey))) {
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

  private peekIdentity(viewerId: string): ViewerIdentity | undefined {
    const handle = this.handleByViewerId.get(viewerId);
    return handle ? this.identities.get(handle) : undefined;
  }

  private refuseRepeat(identity: ViewerIdentity | undefined, text: string): void {
    if (isRepeatOfPrevious(identity?.lastKey, text)) throw new ViewerChatError(LINES.duplicate, 409, 'DUPLICATE_MESSAGE');
  }

  private spend(state: ReturnType<typeof createRateLimiterState>, viewerId: string, networkKey: string, now: number, rules: RateRules): void {
    const decision = tryRecordAction(state, { viewerId, networkKey }, now, rules);
    if (!decision.allowed) throw new ViewerChatError(slowDownLine(decision.retryAfterMs), 429, 'RATE_LIMITED', decision.retryAfterMs);
  }

  private identityFor(viewerId: string, networkKey: string, name: string): ViewerIdentity {
    const known = this.handleByViewerId.get(viewerId);
    const existing = known ? this.identities.get(known) : undefined;
    if (existing) {
      existing.name = name;
      existing.networkKey = networkKey;
      return existing;
    }
    if (this.identities.size >= MAX_IDENTITIES) {
      const oldest = this.identities.values().next().value as ViewerIdentity | undefined;
      if (oldest) {
        this.identities.delete(oldest.handle);
        this.handleByViewerId.delete(oldest.viewerId);
      }
    }
    const identity: ViewerIdentity = { handle: nanoid(8), viewerId, networkKey, name };
    this.identities.set(identity.handle, identity);
    this.handleByViewerId.set(viewerId, identity.handle);
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
