import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '@studio/shared';
import {
  createHighlightedCommentFromChatMessage,
  getHighlightableChatMessages,
} from '../src/components/CommentHighlight.tsx';

const messages: ChatMessage[] = [
  {
    id: 'msg-1',
    senderId: 'guest-1',
    senderName: 'Ari',
    content: 'Great launch segment',
    timestamp: '2026-06-11T10:00:00.000Z',
    isBackstage: false,
  },
  {
    id: 'msg-2',
    senderId: 'producer-1',
    senderName: 'Producer',
    content: 'Ask about pricing next',
    timestamp: '2026-06-11T10:01:00.000Z',
    isBackstage: true,
  },
  {
    id: 'msg-3',
    senderId: 'guest-2',
    senderName: 'Mina',
    content: 'Please show the product demo again',
    timestamp: '2026-06-11T10:02:00.000Z',
    isBackstage: false,
    starred: true,
    starredBy: 'host-1',
    starredAt: '2026-06-11T10:03:00.000Z',
  },
  {
    id: 'msg-4',
    senderId: 'guest-3',
    senderName: 'Noel',
    content: 'The audio sounds clear',
    timestamp: '2026-06-11T10:04:00.000Z',
    isBackstage: false,
    starred: true,
    starredBy: 'host-1',
    starredAt: '2026-06-11T10:05:00.000Z',
  },
  {
    id: 'msg-5',
    senderId: 'host-1',
    senderName: 'Host',
    recipientId: 'guest-1',
    recipientName: 'Ari',
    content: 'Private product demo cue',
    timestamp: '2026-06-11T10:06:00.000Z',
    isBackstage: false,
  },
];

describe('comment highlight selection', () => {
  it('creates broadcast-safe overlay comments from public chat messages only', () => {
    assert.deepEqual(
      createHighlightedCommentFromChatMessage(messages[0]),
      {
        id: 'msg-1',
        senderName: 'Ari',
        content: 'Great launch segment',
      }
    );
    assert.equal(createHighlightedCommentFromChatMessage(messages[1]), null);
    assert.equal(createHighlightedCommentFromChatMessage(messages[4]), null);
  });

  it('returns starred public comments first for the ready filter', () => {
    assert.deepEqual(
      getHighlightableChatMessages(messages, '', 'ready').map((message) => message.id),
      ['msg-4', 'msg-3']
    );
  });

  it('searches public comment senders and content', () => {
    assert.deepEqual(
      getHighlightableChatMessages(messages, 'product demo', 'all').map((message) => message.id),
      ['msg-3']
    );
    assert.deepEqual(
      getHighlightableChatMessages(messages, 'ari launch', 'all').map((message) => message.id),
      ['msg-1']
    );
  });

  it('excludes backstage and direct notes from highlight candidates', () => {
    assert.deepEqual(
      getHighlightableChatMessages(messages, 'pricing', 'all').map((message) => message.id),
      []
    );
    assert.deepEqual(
      getHighlightableChatMessages(messages, 'private cue', 'all').map((message) => message.id),
      []
    );
  });

  it('caps the recent candidate list before sorting newest first', () => {
    const manyMessages = Array.from({ length: 25 }, (_, index): ChatMessage => ({
      id: `recent-${index + 1}`,
      senderId: `guest-${index + 1}`,
      senderName: `Guest ${index + 1}`,
      content: `Comment ${index + 1}`,
      timestamp: new Date(Date.UTC(2026, 5, 11, 10, index)).toISOString(),
      isBackstage: false,
    }));

    assert.deepEqual(
      getHighlightableChatMessages(manyMessages, '', 'recent', 3).map((message) => message.id),
      ['recent-25', 'recent-24', 'recent-23']
    );
  });
});
