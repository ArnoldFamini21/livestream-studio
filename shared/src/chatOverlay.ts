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

/** Features the server advertises in `room-joined`; also used for the update payload type. */
export interface ChatOverlayUpdatePayload {
  patch: ChatOverlayPatch;
}
