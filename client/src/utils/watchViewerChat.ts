import {
  VIEWER_FEED_VISIBLE,
  VIEWER_NAME_MAX,
  VIEWER_REACTION_TYPES,
  type ViewerReactionType,
  type WatchChatMessage,
  type WatchLiveResponse,
} from '@studio/shared';

/**
 * Watch-page viewer chat, the parts that need no screen: the name kept in the
 * browser, the list of messages a page holds, what to ask the server for, and
 * how to read its answer. The server decides everything that matters (the
 * switches, the limits, the filter, the blocks); this only shows the result.
 */

const NAME_KEY = 'livestream-studio:watch-viewer-name';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Plain text of at most the name limit: spaces tidied, nothing else changed (the server cleans the rest). */
export function tidyViewerName(value: string): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, VIEWER_NAME_MAX).join('');
}

/** The name kept in this browser, else the registration name, else nothing yet. */
export function readViewerName(registeredName = '', storage: StorageLike | null = defaultStorage()): string {
  try {
    const stored = storage?.getItem(NAME_KEY);
    if (stored && tidyViewerName(stored)) return tidyViewerName(stored);
  } catch { /* storage blocked: fall back to the registration name */ }
  return tidyViewerName(registeredName);
}

export function saveViewerName(name: string, storage: StorageLike | null = defaultStorage()): void {
  const tidy = tidyViewerName(name);
  if (!tidy) return;
  try { storage?.setItem(NAME_KEY, tidy); } catch { /* not persisted */ }
}

/** What a page holds: where it is in the server's feed, and the list on screen (oldest first). */
export interface WatchChatView {
  epoch: string | null;
  cursor: number | null;
  messages: WatchChatMessage[];
}

export function emptyChatView(): WatchChatView {
  return { epoch: null, cursor: null, messages: [] };
}

/** The part of the address that asks only for what is new. A page that has nothing yet asks for the recent list. */
export function liveQuery(view: Pick<WatchChatView, 'epoch' | 'cursor'>): string {
  if (view.epoch === null || view.cursor === null) return '';
  return `?after=${encodeURIComponent(String(view.cursor))}&epoch=${encodeURIComponent(view.epoch)}`;
}

function capMessages(messages: WatchChatMessage[]): WatchChatMessage[] {
  return messages.length > VIEWER_FEED_VISIBLE ? messages.slice(messages.length - VIEWER_FEED_VISIBLE) : messages;
}

/** Folds the server's answer into what the page holds. The same object comes back when nothing changed. */
export function applyLiveResponse(view: WatchChatView, response: WatchLiveResponse): WatchChatView {
  // Chat is off: show nothing, but keep the place in the server's list. Reactions are still read from it,
  // and when chat comes back the server tells the page to start over with a fresh list.
  if (!response.switches.chat) {
    return view.messages.length === 0 && view.epoch === response.epoch && view.cursor === response.cursor
      ? view
      : { epoch: response.epoch, cursor: response.cursor, messages: [] };
  }
  if (response.reset) {
    return { epoch: response.epoch, cursor: response.cursor, messages: capMessages(response.messages) };
  }
  let messages = view.messages;
  if (response.removed.length > 0) {
    const gone = new Set(response.removed);
    messages = messages.filter((message) => !gone.has(message.id));
  }
  if (response.messages.length > 0) {
    const have = new Set(messages.map((message) => message.id));
    const fresh = response.messages.filter((message) => !have.has(message.id));
    if (fresh.length > 0) messages = capMessages([...messages, ...fresh]);
  }
  if (messages === view.messages && view.epoch === response.epoch && view.cursor === response.cursor) return view;
  return { epoch: response.epoch, cursor: response.cursor, messages };
}

/** Shows the viewer's own message at once; the next answer from the server carries it again and is not added twice. */
export function addSentMessage(view: WatchChatView, message: WatchChatMessage): WatchChatView {
  if (view.messages.some((existing) => existing.id === message.id)) return view;
  return { ...view, messages: capMessages([...view.messages, message]) };
}

/** Most floating reactions a page draws from one answer (a busy room would otherwise fill the picture). */
export const MAX_FLOATING_REACTIONS_PER_ANSWER = 8;

/**
 * The reactions to float for one answer: the counts minus the ones this page
 * already floated when its own viewer tapped (`own`), spread across the types
 * and bounded. Returns the types in the order they should float.
 */
export function reactionsToFloat(
  counts: Partial<Record<ViewerReactionType, number>>,
  own: Partial<Record<ViewerReactionType, number>> = {},
): { floats: ViewerReactionType[]; ownLeft: Partial<Record<ViewerReactionType, number>> } {
  const remaining: Partial<Record<ViewerReactionType, number>> = {};
  const ownLeft: Partial<Record<ViewerReactionType, number>> = { ...own };
  for (const type of VIEWER_REACTION_TYPES) {
    const raw = counts[type];
    const count = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    const mine = Math.min(count, ownLeft[type] ?? 0);
    if (mine > 0) ownLeft[type] = (ownLeft[type] ?? 0) - mine;
    if (count - mine > 0) remaining[type] = count - mine;
  }
  const floats: ViewerReactionType[] = [];
  // One of each type in turn, so a burst of one reaction does not hide the others.
  while (floats.length < MAX_FLOATING_REACTIONS_PER_ANSWER) {
    let added = false;
    for (const type of VIEWER_REACTION_TYPES) {
      if ((remaining[type] ?? 0) > 0 && floats.length < MAX_FLOATING_REACTIONS_PER_ANSWER) {
        remaining[type] = (remaining[type] ?? 0) - 1;
        floats.push(type);
        added = true;
      }
    }
    if (!added) break;
  }
  return { floats, ownLeft };
}

/** The line shown to a viewer when a send fails. The server's own plain line wins; these cover a server that cannot answer. */
export function sendFailureLine(error: unknown): string {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  const message = error instanceof Error ? error.message : '';
  if (status === 429 && !message) return 'Please slow down and try again in a few seconds.';
  if (message && typeof status === 'number') return message;
  return 'That did not go through. Please check your connection and try again.';
}
