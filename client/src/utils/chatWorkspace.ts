import type { ChatMessage } from '@studio/shared';
import { getChatTranscriptMessages, type ChatTranscriptScope } from './chatTranscript.ts';

export const MAX_CHAT_MESSAGE_LENGTH = 2000;

export function getChatDraftKey(scope: ChatTranscriptScope, recipientId = ''): string {
  return scope === 'direct' ? `direct:${recipientId}` : scope;
}

export function prepareStudioChatMessage(
  value: string,
  scope: ChatTranscriptScope,
  recipientId: string,
  availableRecipientIds: string[]
): { content: string; isBackstage: boolean; recipientId?: string } | null {
  const content = value.trim();
  if (!content || content.length > MAX_CHAT_MESSAGE_LENGTH || scope === 'social' || scope === 'starred') return null;
  if (scope === 'direct' && (!recipientId || !availableRecipientIds.includes(recipientId))) return null;
  return { content, isBackstage: scope === 'backstage', ...(scope === 'direct' ? { recipientId } : {}) };
}

export function getStudioChatMessages(messages: ChatMessage[], scope: ChatTranscriptScope, myId: string, recipientId = ''): ChatMessage[] {
  const scoped = getChatTranscriptMessages(messages, scope);
  if (scope !== 'direct') return scoped;
  return scoped.filter(message => {
    if (message.senderId !== myId && message.recipientId !== myId) return false;
    return !recipientId || message.senderId === recipientId || message.recipientId === recipientId;
  });
}

export function isPublicChatMessage(message: Pick<ChatMessage, 'isBackstage' | 'recipientId'>): boolean {
  return !message.isBackstage && !message.recipientId;
}
