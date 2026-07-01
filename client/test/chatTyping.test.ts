import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatChatTypingNames,
  getChatTypingNames,
  upsertChatTypingIndicator,
  type ChatTypingIndicator,
} from '../src/utils/chatTyping.ts';

const NOW = 1_000;

function typing(overrides: Partial<ChatTypingIndicator> = {}) {
  return {
    participantId: 'guest-1',
    participantName: 'Guest',
    typing: true,
    timestamp: new Date(NOW).toISOString(),
    isBackstage: false,
    expiresAt: NOW + 3_500,
    ...overrides,
  };
}

describe('chat typing indicators', () => {
  it('adds, refreshes, and stops typing indicators by channel', () => {
    const first = upsertChatTypingIndicator([], typing(), 'host-1', NOW);
    assert.equal(first.length, 1);

    const refreshed = upsertChatTypingIndicator(first, typing({ participantName: 'Guest Renamed' }), 'host-1', NOW + 100);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].participantName, 'Guest Renamed');
    assert.equal(getChatTypingNames(refreshed, 'public', NOW + 100)[0], 'Guest Renamed');

    const stopped = upsertChatTypingIndicator(refreshed, typing({ typing: false }), 'host-1', NOW + 200);
    assert.equal(stopped.length, 0);
  });

  it('separates public, direct, and backstage typing scopes', () => {
    const indicators = [
      typing({ participantId: 'public-1', participantName: 'Public' }),
      typing({ participantId: 'direct-1', participantName: 'Direct', recipientId: 'host-1' }),
      typing({ participantId: 'backstage-1', participantName: 'Backstage', isBackstage: true }),
    ];

    assert.deepEqual(getChatTypingNames(indicators, 'public', NOW), ['Public']);
    assert.deepEqual(getChatTypingNames(indicators, 'direct', NOW), ['Direct']);
    assert.deepEqual(getChatTypingNames(indicators, 'backstage', NOW), ['Backstage']);
  });

  it('ignores self and expired indicators', () => {
    const expired = typing({ participantId: 'old-1', participantName: 'Old', expiresAt: NOW - 1 });
    const next = upsertChatTypingIndicator([expired], typing({ participantId: 'host-1' }), 'host-1', NOW);

    assert.deepEqual(next, []);
  });

  it('formats compact typing text', () => {
    assert.equal(formatChatTypingNames([]), '');
    assert.equal(formatChatTypingNames(['Arnold']), 'Arnold is typing...');
    assert.equal(formatChatTypingNames(['Arnold', 'Guest']), 'Arnold and Guest are typing...');
    assert.equal(formatChatTypingNames(['Arnold', 'Guest', 'Producer']), 'Arnold and 2 others are typing...');
  });
});
