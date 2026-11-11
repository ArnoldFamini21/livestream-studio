import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { CHAT_REACTION_LABELS, CHAT_REACTION_TYPES } from '@studio/shared';
import { isQuestion } from './questionDetection.ts';

export type ChatTranscriptScope = 'public' | 'social' | 'starred' | 'backstage' | 'direct';

const SCOPE_LABELS: Record<ChatTranscriptScope, string> = {
  public: 'Public',
  social: 'Social',
  starred: 'Starred',
  backstage: 'Backstage',
  direct: 'Direct',
};

/**
 * A spreadsheet runs a cell that starts with = + - @ (or a tab / carriage
 * return) as a formula. Chat text is untrusted, so such a cell gets a leading
 * single quote and opens as plain text.
 */
export function guardSpreadsheetFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const normalized = guardSpreadsheetFormula(String(value ?? ''));
  return `"${normalized.replace(/"/g, '""')}"`;
}

export interface ChatTranscriptOptions {
  /** Ids of comments already put on screen with the "feature on screen" highlight. */
  shownIds?: Iterable<string>;
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
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
      if (scope === 'social') return !message.isBackstage && !message.recipientId && Boolean(message.source?.platform);
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
  scope: ChatTranscriptScope,
  options: ChatTranscriptOptions = {}
): string {
  const shown = new Set(options.shownIds ?? []);
  // The first six columns are the chat history; the rest are the producer details kept from before.
  const header = [
    'Time', 'Source', 'Author', 'Message', 'Question', 'Shown on screen',
    'Recipient', 'Channel', 'External ID', 'Pinned', 'Starred', 'Reactions',
  ];
  const rows = getChatTranscriptMessages(messages, scope).map((message) => [
    formatTimestamp(message.timestamp),
    message.source?.platform || 'studio',
    message.senderName,
    message.content,
    yesNo(isQuestion(message.content)),
    yesNo(shown.has(message.id)),
    message.recipientName || '',
    SCOPE_LABELS[message.recipientId ? 'direct' : message.isBackstage ? 'backstage' : message.source?.platform ? 'social' : 'public'],
    message.source?.externalId || '',
    message.pinned ? 'Yes' : 'No',
    message.starred ? 'Yes' : 'No',
    formatReactions(message.reactions),
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n') + '\r\n';
}

/** Plain-text transcript, one comment per entry: time, source, author, message and markers. */
export function buildChatTranscriptTxt(
  messages: ChatMessage[],
  scope: ChatTranscriptScope,
  options: ChatTranscriptOptions = {}
): string {
  const shown = new Set(options.shownIds ?? []);
  const lines = getChatTranscriptMessages(messages, scope).map((message) => {
    const markers = [
      isQuestion(message.content) ? 'question' : '',
      shown.has(message.id) ? 'shown on screen' : '',
    ].filter(Boolean);
    const body = message.content.replace(/\r\n?|\n/g, '\n    ');
    return `[${formatTimestamp(message.timestamp)}] (${message.source?.platform || 'studio'}) ${message.senderName}: ${body}${markers.length ? ` [${markers.join(', ')}]` : ''}`;
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export type ChatTranscriptFormat = 'csv' | 'txt';

export function buildChatTranscriptFilename(
  scope: ChatTranscriptScope,
  now = new Date(),
  format: ChatTranscriptFormat = 'csv'
): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  return `studio_chat_${scope}_${stamp}.${format}`;
}
