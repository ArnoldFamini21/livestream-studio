import type { ChatMessage } from '@studio/shared';

/**
 * Messages from other people that arrived after the reader last had the chat
 * open. Private messages meant for someone else never count.
 */
export function countUnreadChatMessages(
  messages: readonly ChatMessage[],
  myParticipantId: string | null | undefined,
  seenAtMs: number
): number {
  let count = 0;
  for (const message of messages) {
    if (message.senderId === myParticipantId) continue;
    if (message.recipientId && message.recipientId !== myParticipantId) continue;
    const sentAt = Date.parse(message.timestamp);
    if (Number.isFinite(sentAt) && sentAt > seenAtMs) count++;
  }
  return count;
}

/** "9+" keeps the badge small. */
export function formatUnreadBadge(count: number): string {
  return count > 9 ? '9+' : String(count);
}
