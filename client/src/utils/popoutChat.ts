import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { isChatReactionType } from '@studio/shared';

export const POPOUT_CHAT_SESSION_PARAM = 'session';
const POPOUT_CHAT_CHANNEL_PREFIX = 'livestream-studio:popout-chat';

export interface PopoutChatState {
  type: 'state';
  roomId: string;
  roomName: string;
  senderName: string;
  connected: boolean;
  messages: ChatMessage[];
  updatedAt: string;
}

export type PopoutChatCommand =
  | { type: 'ready' }
  | { type: 'request-state' }
  | { type: 'send-message'; payload: { content: string; isBackstage: boolean } }
  | { type: 'react'; payload: { messageId: string; reaction: ChatReactionType } }
  | { type: 'toggle-star'; payload: { messageId: string; starred: boolean } };

export type PopoutChatMessage = PopoutChatState | PopoutChatCommand;

function getRandomValues(length: number): Uint8Array {
  const values = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values);
    return values;
  }
  for (let index = 0; index < values.length; index += 1) {
    values[index] = Math.floor(Math.random() * 256);
  }
  return values;
}

export function createPopoutChatSessionId(): string {
  return Array.from(getRandomValues(12))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function isValidPopoutChatSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

export function getPopoutChatChannelName(roomId: string, sessionId: string): string {
  return `${POPOUT_CHAT_CHANNEL_PREFIX}:${encodeURIComponent(roomId)}:${sessionId}`;
}

export function buildPopoutChatUrl(baseUrl: string, roomId: string, sessionId: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const path = `/studio/${encodeURIComponent(roomId)}/popout-chat`;
  const query = `${POPOUT_CHAT_SESSION_PARAM}=${encodeURIComponent(sessionId)}`;
  return `${cleanBase}${path}?${query}`;
}

export function readPopoutChatSession(search: string): string {
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  try {
    const sessionId = new URLSearchParams(normalized).get(POPOUT_CHAT_SESSION_PARAM) || '';
    return isValidPopoutChatSessionId(sessionId) ? sessionId : '';
  } catch {
    return '';
  }
}

export function isPopoutChatCommand(value: unknown): value is PopoutChatCommand {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<PopoutChatCommand>;
  if (message.type === 'ready' || message.type === 'request-state') return true;
  if (!('payload' in message) || !message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as Record<string, unknown>;
  if (message.type === 'send-message') {
    return typeof payload.content === 'string'
      && payload.content.trim().length > 0
      && typeof payload.isBackstage === 'boolean';
  }
  if (message.type === 'react') {
    return typeof payload.messageId === 'string'
      && isChatReactionType(payload.reaction);
  }
  if (message.type === 'toggle-star') {
    return typeof payload.messageId === 'string' && typeof payload.starred === 'boolean';
  }
  return false;
}
