import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { CHAT_REACTION_LABELS, CHAT_REACTION_TYPES } from '@studio/shared';

export type ChatTranscriptScope = 'public' | 'starred' | 'backstage' | 'direct';

const SCOPE_LABELS: Record<ChatTranscriptScope, string> = {
  public: 'Public',
  starred: 'Starred',
  backstage: 'Backstage',
  direct: 'Direct',
};

function csvCell(value: string | number | boolean | null | undefined): string {
  const normalized = String(value ?? '');
  return `"${normalized.replace(/"/g, '""')}"`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString();
}

function formatReactions(reactions: ChatMessage['reactions']): string {
  if (!reactions) return '';
  return CHAT_REACTION_TYPES
    .map((reaction: ChatReactionType) => {
      const count = reactions[reaction] || 0;
      return count > 0 ? `${CHAT_REACTION_LABELS[reaction]}: ${count}` : null;
    })
    .filter(Boolean)
    .join('; ');
}

export function getChatTranscriptMessages(
  messages: ChatMessage[],
  scope: ChatTranscriptScope
): ChatMessage[] {
  return messages
    .filter((message) => {
      if (scope === 'backstage') return message.isBackstage;
      if (scope === 'direct') return Boolean(message.recipientId);
      if (scope === 'starred') return !message.isBackstage && !message.recipientId && Boolean(message.starred);
      return !message.isBackstage && !message.recipientId;
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.timestamp);
      const bTime = Date.parse(b.timestamp);
      if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
      if (!Number.isFinite(aTime)) return 1;
      if (!Number.isFinite(bTime)) return -1;
      return aTime - bTime;
    });
}

export function buildChatTranscriptCsv(
  messages: ChatMessage[],
  scope: ChatTranscriptScope
): string {
  const header = ['Timestamp', 'Sender', 'Recipient', 'Channel', 'Pinned', 'Starred', 'Reactions', 'Message'];
  const rows = getChatTranscriptMessages(messages, scope).map((message) => [
    formatTimestamp(message.timestamp),
    message.senderName,
    message.recipientName || '',
    SCOPE_LABELS[message.recipientId ? 'direct' : message.isBackstage ? 'backstage' : 'public'],
    message.pinned ? 'Yes' : 'No',
    message.starred ? 'Yes' : 'No',
    formatReactions(message.reactions),
    message.content,
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n') + '\r\n';
}

export function buildChatTranscriptFilename(
  scope: ChatTranscriptScope,
  now = new Date()
): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  return `studio_chat_${scope}_${stamp}.csv`;
}
