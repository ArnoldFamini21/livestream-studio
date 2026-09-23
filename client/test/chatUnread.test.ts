import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '@studio/shared';
import { countUnreadChatMessages, formatUnreadBadge } from '../src/utils/chatUnread.ts';

const message = (id: string, senderId: string, at: number, recipientId?: string): ChatMessage => ({
  id, senderId, senderName: senderId, content: 'hi', timestamp: new Date(at).toISOString(), isBackstage: false,
  ...(recipientId ? { recipientId } : {}),
});

describe('countUnreadChatMessages', () => {
  it('counts messages from others after the chat was last seen', () => {
    const messages = [message('1', 'host', 1_000), message('2', 'host', 3_000), message('3', 'guest', 4_000)];
    assert.equal(countUnreadChatMessages(messages, 'guest', 2_000), 1);
    assert.equal(countUnreadChatMessages(messages, 'guest', 0), 2);
  });

  it('ignores private messages meant for someone else', () => {
    const messages = [message('1', 'host', 3_000, 'other-guest'), message('2', 'host', 3_000, 'guest')];
    assert.equal(countUnreadChatMessages(messages, 'guest', 0), 1);
  });

  it('caps the badge text', () => {
    assert.equal(formatUnreadBadge(3), '3');
    assert.equal(formatUnreadBadge(12), '9+');
  });
});
