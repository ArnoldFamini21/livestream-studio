/**
 * Settings of the on-screen chat overlay ("Chat on screen"), shared by the
 * server (validation, storage, relay) and the client (host controls, preview,
 * compositor). Hosts and co-hosts change them with small patches so two
 * operators never overwrite each other's hide / shown updates.
 */

export const CHAT_OVERLAY_SIZES = ['s', 'm', 'l'] as const;
export type ChatOverlaySize = typeof CHAT_OVERLAY_SIZES[number];
export const CHAT_OVERLAY_LAYOUTS = ['regular', 'tall', 'wide'] as const;
export type ChatOverlayLayout = typeof CHAT_OVERLAY_LAYOUTS[number];
export const CHAT_OVERLAY_SIDES = ['left', 'right'] as const;
export type ChatOverlaySide = typeof CHAT_OVERLAY_SIDES[number];
export const CHAT_OVERLAY_MODES = ['all', 'approved'] as const;
export type ChatOverlayMode = typeof CHAT_OVERLAY_MODES[number];

/** Longest id kept, and how many ids each list keeps (oldest dropped first). */
export const CHAT_OVERLAY_MAX_ID_LENGTH = 128;
export const CHAT_OVERLAY_MAX_IDS = 200;
/** Signaling budget for `chat-overlay-update`: a busy producer, never a flood. */
export const CHAT_OVERLAY_RATE_LIMIT_MAX = 40;
export const CHAT_OVERLAY_RATE_LIMIT_WINDOW_MS = 10_000;

export interface ChatOverlayState {
  enabled: boolean;
  size: ChatOverlaySize;
  layout: ChatOverlayLayout;
  side: ChatOverlaySide;
  /** `all`: every public comment appears. `approved`: only comments the host starred or featured. */
  mode: ChatOverlayMode;
  /** Frozen: the overlay keeps showing `pausedIds` while new comments arrive. */
  paused: boolean;
  pausedIds: string[];
  /** Comments the host hid from the overlay only (they stay in the chat list). */
  hiddenIds: string[];
  /** Comments already put on screen with the "feature on screen" highlight. */
  shownIds: string[];
  updatedAt?: string;
}

export interface ChatOverlayPatch {
  enabled?: boolean;
  size?: ChatOverlaySize;
  layout?: ChatOverlayLayout;
  side?: ChatOverlaySide;
  mode?: ChatOverlayMode;
  paused?: boolean;
  /** With `paused: true`: the comment ids visible at that moment. */
  pausedIds?: string[];
  hide?: string[];
  unhide?: string[];
  show?: string[];
  clearHidden?: boolean;
}

export function defaultChatOverlayState(): ChatOverlayState {
  return {
    enabled: false,
    size: 'm',
    layout: 'regular',
    side: 'left',
    mode: 'all',
    paused: false,
    pausedIds: [],
    hiddenIds: [],
    shownIds: [],
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** Valid, bounded, de-duplicated ids; newest (last) kept when over the cap. */
export function normalizeChatOverlayIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > CHAT_OVERLAY_MAX_ID_LENGTH) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > CHAT_OVERLAY_MAX_IDS ? out.slice(out.length - CHAT_OVERLAY_MAX_IDS) : out;
}

export function normalizeChatOverlayState(raw: unknown): ChatOverlayState {
  const base = defaultChatOverlayState();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Record<string, unknown>;
  const paused = value.paused === true;
  return {
    enabled: value.enabled === true,
    size: pick(value.size, CHAT_OVERLAY_SIZES, base.size),
    layout: pick(value.layout, CHAT_OVERLAY_LAYOUTS, base.layout),
    side: pick(value.side, CHAT_OVERLAY_SIDES, base.side),
    mode: pick(value.mode, CHAT_OVERLAY_MODES, base.mode),
    paused,
    pausedIds: paused ? normalizeChatOverlayIds(value.pausedIds) : [],
    hiddenIds: normalizeChatOverlayIds(value.hiddenIds),
    shownIds: normalizeChatOverlayIds(value.shownIds),
    ...(typeof value.updatedAt === 'string' && value.updatedAt.length <= 40 ? { updatedAt: value.updatedAt } : {}),
  };
}

/** Validates a client patch; returns null when it holds nothing usable. Unknown keys are dropped. */
export function normalizeChatOverlayPatch(raw: unknown): ChatOverlayPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const patch: ChatOverlayPatch = {};
  if (typeof value.enabled === 'boolean') patch.enabled = value.enabled;
  if (typeof value.paused === 'boolean') patch.paused = value.paused;
  if (typeof value.size === 'string' && (CHAT_OVERLAY_SIZES as readonly string[]).includes(value.size)) patch.size = value.size as ChatOverlaySize;
  if (typeof value.layout === 'string' && (CHAT_OVERLAY_LAYOUTS as readonly string[]).includes(value.layout)) patch.layout = value.layout as ChatOverlayLayout;
  if (typeof value.side === 'string' && (CHAT_OVERLAY_SIDES as readonly string[]).includes(value.side)) patch.side = value.side as ChatOverlaySide;
  if (typeof value.mode === 'string' && (CHAT_OVERLAY_MODES as readonly string[]).includes(value.mode)) patch.mode = value.mode as ChatOverlayMode;
  for (const key of ['pausedIds', 'hide', 'unhide', 'show'] as const) {
    if (Array.isArray(value[key])) patch[key] = normalizeChatOverlayIds(value[key]);
  }
  if (value.clearHidden === true) patch.clearHidden = true;
  return Object.keys(patch).length > 0 ? patch : null;
}

function addIds(list: string[], ids: string[] | undefined): string[] {
  if (!ids || ids.length === 0) return list;
  const next = list.filter((id) => !ids.includes(id));
  next.push(...ids);
  return next.length > CHAT_OVERLAY_MAX_IDS ? next.slice(next.length - CHAT_OVERLAY_MAX_IDS) : next;
}

/** Pure: applies a (normalized) patch and returns the new state. */
export function applyChatOverlayPatch(state: ChatOverlayState, patch: ChatOverlayPatch): ChatOverlayState {
  const next: ChatOverlayState = { ...state };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.size) next.size = patch.size;
  if (patch.layout) next.layout = patch.layout;
  if (patch.side) next.side = patch.side;
  if (patch.mode) next.mode = patch.mode;
  if (patch.paused !== undefined) {
    next.paused = patch.paused;
    next.pausedIds = patch.paused ? normalizeChatOverlayIds(patch.pausedIds ?? state.pausedIds) : [];
  }
  if (patch.clearHidden) next.hiddenIds = [];
  if (patch.unhide?.length) next.hiddenIds = next.hiddenIds.filter((id) => !patch.unhide!.includes(id));
  next.hiddenIds = addIds(next.hiddenIds, patch.hide);
  next.shownIds = addIds(next.shownIds, patch.show);
  return next;
}

export function isDefaultChatOverlayState(state: ChatOverlayState): boolean {
  const base = defaultChatOverlayState();
  return state.enabled === base.enabled && state.size === base.size && state.layout === base.layout
    && state.side === base.side && state.mode === base.mode && !state.paused
    && state.hiddenIds.length === 0 && state.shownIds.length === 0;
}

/** The patch that rebuilds `state` from a default state (a host republishing its browser copy to a server that lost it). */
export function chatOverlayStateToPatch(state: ChatOverlayState): ChatOverlayPatch {
  return {
    enabled: state.enabled,
    size: state.size,
    layout: state.layout,
    side: state.side,
    mode: state.mode,
    paused: state.paused,
    ...(state.paused ? { pausedIds: state.pausedIds } : {}),
    ...(state.hiddenIds.length ? { hide: state.hiddenIds } : {}),
    ...(state.shownIds.length ? { show: state.shownIds } : {}),
  };
}

/** What a client does with its browser copy of the settings right after `room-joined`. */
export type ChatOverlayJoinDecision = 'publish' | 'reset' | 'keep';

/**
 * Decided once per join, right after `room-joined`:
 * - `keep`: the server sent its state (it wins), or it does not know the
 *   feature (everything stays local), or this host has nothing but defaults.
 * - `publish`: the server holds nothing and this is the HOST with a browser
 *   copy worth keeping: send it once.
 * - `reset`: the server holds nothing and this is anyone else: show the
 *   defaults and ignore the browser copy (it may be from an earlier session).
 */
export function decideChatOverlayOnJoin(input: {
  isHost: boolean;
  serverSupported: boolean;
  serverHasState: boolean;
  local: ChatOverlayState;
}): ChatOverlayJoinDecision {
  if (!input.serverSupported || input.serverHasState) return 'keep';
  if (!input.isHost) return 'reset';
  return isDefaultChatOverlayState(input.local) ? 'keep' : 'publish';
}

/** A browser copy never brings back a pause: its comment ids belong to an earlier session. */
export function loadSavedChatOverlayState(raw: unknown): ChatOverlayState {
  return { ...normalizeChatOverlayState(raw), paused: false, pausedIds: [] };
}

/** A client-chosen change number: a non-negative safe integer, anything else is no number. */
export function normalizeChatOverlaySeq(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

/** Value equality of two states (the parts that matter on screen), so an unchanged state keeps its object. */
export function chatOverlayStatesEqual(a: ChatOverlayState, b: ChatOverlayState): boolean {
  if (a === b) return true;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((id, index) => id === y[index]);
  return a.enabled === b.enabled && a.size === b.size && a.layout === b.layout && a.side === b.side
    && a.mode === b.mode && a.paused === b.paused && same(a.pausedIds, b.pausedIds)
    && same(a.hiddenIds, b.hiddenIds) && same(a.shownIds, b.shownIds);
}

/** A change sent to the server that the server has not answered yet. */
export interface PendingChatOverlayPatch {
  seq: number;
  patch: ChatOverlayPatch;
  /** Milliseconds (Date.now()) when it was sent. */
  sentAt: number;
}

/** A change nobody answered within this time is given up (lost or rejected). */
export const CHAT_OVERLAY_PENDING_TTL_MS = 3000;

/** Drops the changes that have waited the full time without an answer. */
export function expireChatOverlayPending(
  pending: PendingChatOverlayPatch[],
  now: number,
  ttlMs: number = CHAT_OVERLAY_PENDING_TTL_MS,
): PendingChatOverlayPatch[] {
  const kept = pending.filter((entry) => now - entry.sentAt < ttlMs);
  return kept.length === pending.length ? pending : kept;
}

/**
 * What to show when the server's state arrives: the server state with this
 * browser's not yet answered changes laid on top, in the order they were made,
 * so an echo of an earlier change never undoes a later one. Changes the server
 * answered (`seq <= ack`) or that waited too long are dropped.
 */
export function reconcileChatOverlay(input: {
  server: ChatOverlayState;
  ack?: number;
  pending: PendingChatOverlayPatch[];
  now: number;
  ttlMs?: number;
}): { state: ChatOverlayState; pending: PendingChatOverlayPatch[] } {
  const ack = normalizeChatOverlaySeq(input.ack);
  const answered = ack === undefined ? input.pending : input.pending.filter((entry) => entry.seq > ack);
  const pending = expireChatOverlayPending(answered, input.now, input.ttlMs);
  const state = pending.reduce((current, entry) => applyChatOverlayPatch(current, entry.patch), input.server);
  return { state, pending };
}

/** Payload of `chat-overlay-update`. `seq` (optional) is echoed back to the sender as `ack`. */
export interface ChatOverlayUpdatePayload {
  patch: ChatOverlayPatch;
  seq?: number;
}

/** Payload of `chat-overlay-updated`: the full state; `ack` only in the copy sent to the sender of the change. */
export type ChatOverlayUpdatedPayload = ChatOverlayState & { ack?: number };
