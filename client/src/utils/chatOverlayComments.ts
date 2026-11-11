import type { ChatMessage, ChatOverlayState } from '@studio/shared';
import { isQuestion } from './questionDetection.ts';

/**
 * Which comments may reach the on-screen chat overlay, and in what shape.
 * Everything here is pure. All comment text is untrusted: it is reduced to
 * plain, bounded text before any renderer sees it.
 */

/** Longest comment shown on screen (code points); longer text ends in an ellipsis. */
export const CHAT_OVERLAY_MAX_TEXT = 200;
export const CHAT_OVERLAY_MAX_AUTHOR = 40;
/** Newest eligible comments kept in memory for the overlay, whatever the chat holds. */
export const CHAT_OVERLAY_BUFFER_MAX = 40;

/** Where a comment came from; watch-page chat can be added as another value later. */
export type ChatOverlaySource = 'studio' | 'youtube' | 'facebook';

export interface ChatOverlayComment {
  id: string;
  author: string;
  text: string;
  question: boolean;
  source: ChatOverlaySource;
  /** Epoch ms (NaN-safe: 0 when the message has no valid time). */
  at: number;
}

// C0 and C1 controls, DEL, line / paragraph separators, zero-width characters, and every
// bidirectional embedding, override, isolate and mark character.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Plain, single-line, bounded text. Never returns control or bidi characters. */
export function sanitizeOverlayText(value: unknown, maxLength = CHAT_OVERLAY_MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  // Cap the work on huge input before touching it.
  const bounded = value.length > maxLength * 8 ? value.slice(0, maxLength * 8) : value;
  const flat = bounded.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  if (points.length <= maxLength) return flat;
  return `${points.slice(0, Math.max(0, maxLength - 1)).join('').trimEnd()}\u2026`;
}

/** Public room or platform comment: never backstage, never a private / direct message. */
export function isPublicOverlayCandidate(message: Pick<ChatMessage, 'isBackstage' | 'recipientId'>): boolean {
  return !message.isBackstage && !message.recipientId;
}

export interface SelectOverlayCommentsInput {
  messages: readonly ChatMessage[];
  settings: Pick<ChatOverlayState, 'mode' | 'paused' | 'pausedIds' | 'hiddenIds' | 'shownIds'>;
  /** Participants who are still in the green room; nothing they sent may reach the program. */
  greenRoomIds: ReadonlySet<string>;
  /** Cap on comments returned (the layout fits fewer when they are tall). */
  limit?: number;
}

function messageTime(message: ChatMessage): number {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The comments the overlay may show right now, oldest first. Applies, in
 * order: privacy (public only, not from the green room), the host's hide
 * list, approved mode (starred or shown on screen), and pause (the frozen id
 * list). The result is bounded and its text sanitized.
 */
export function selectOverlayComments({ messages, settings, greenRoomIds, limit = CHAT_OVERLAY_BUFFER_MAX }: SelectOverlayCommentsInput): ChatOverlayComment[] {
  const hidden = new Set(settings.hiddenIds);
  const shown = new Set(settings.shownIds);
  const frozen = settings.paused ? new Set(settings.pausedIds) : null;
  const eligible: Array<{ message: ChatMessage; at: number; order: number }> = [];
  messages.forEach((message, order) => {
    if (!isPublicOverlayCandidate(message)) return;
    if (greenRoomIds.has(message.senderId)) return;
    if (hidden.has(message.id)) return;
    if (frozen) {
      if (!frozen.has(message.id)) return;
    } else if (settings.mode === 'approved' && !message.starred && !shown.has(message.id)) {
      return;
    }
    eligible.push({ message, at: messageTime(message), order });
  });
  eligible.sort((a, b) => a.at - b.at || a.order - b.order);
  const newest = eligible.length > limit ? eligible.slice(eligible.length - limit) : eligible;
  const out: ChatOverlayComment[] = [];
  for (const { message, at } of newest) {
    const text = sanitizeOverlayText(message.content);
    if (!text) continue;
    out.push({
      id: message.id,
      author: sanitizeOverlayText(message.senderName, CHAT_OVERLAY_MAX_AUTHOR) || 'Viewer',
      text,
      // Questions are judged on the sanitized text, the same text the overlay shows.
      question: isQuestion(text),
      source: message.source?.platform === 'youtube' || message.source?.platform === 'facebook' ? message.source.platform : 'studio',
      at,
    });
  }
  return out;
}
