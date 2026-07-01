import type { ChatTypingPayload } from '@studio/shared';

export const CHAT_TYPING_TTL_MS = 3_500;

export interface ChatTypingIndicator extends ChatTypingPayload {
  expiresAt: number;
}

export type ChatTypingChannel = 'public' | 'direct' | 'backstage';

function normalizeName(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 50);
}

export function getChatTypingKey(payload: Pick<ChatTypingPayload, 'participantId' | 'isBackstage' | 'recipientId'>): string {
  const channel = payload.isBackstage
    ? 'backstage'
    : payload.recipientId
      ? `direct:${payload.recipientId}`
      : 'public';
  return `${payload.participantId}:${channel}`;
}

export function removeExpiredChatTypingIndicators(
  indicators: ChatTypingIndicator[],
  nowMs = Date.now()
): ChatTypingIndicator[] {
  return indicators.filter((indicator) => indicator.expiresAt > nowMs);
}

export function upsertChatTypingIndicator(
  indicators: ChatTypingIndicator[],
  payload: ChatTypingPayload,
  selfParticipantId: string,
  nowMs = Date.now()
): ChatTypingIndicator[] {
  if (payload.participantId === selfParticipantId) {
    return removeExpiredChatTypingIndicators(indicators, nowMs);
  }

  const key = getChatTypingKey(payload);
  const current = removeExpiredChatTypingIndicators(indicators, nowMs)
    .filter((indicator) => getChatTypingKey(indicator) !== key);

  if (!payload.typing) return current;

  const participantName = normalizeName(payload.participantName);
  if (!payload.participantId || !participantName) return current;

  return [
    ...current,
    {
      ...payload,
      participantName,
      expiresAt: nowMs + CHAT_TYPING_TTL_MS,
    },
  ];
}

export function getChatTypingNames(
  indicators: ChatTypingIndicator[],
  channel: ChatTypingChannel,
  nowMs = Date.now()
): string[] {
  const names = new Set<string>();
  for (const indicator of removeExpiredChatTypingIndicators(indicators, nowMs)) {
    if (channel === 'backstage' && !indicator.isBackstage) continue;
    if (channel === 'public' && (indicator.isBackstage || indicator.recipientId)) continue;
    if (channel === 'direct' && (indicator.isBackstage || !indicator.recipientId)) continue;
    names.add(indicator.participantName);
  }
  return Array.from(names);
}

export function formatChatTypingNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  return `${names[0]} and ${names.length - 1} others are typing...`;
}
