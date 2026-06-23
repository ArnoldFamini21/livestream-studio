import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPopoutChatUrl,
  createPopoutChatSessionId,
  getPopoutChatChannelName,
  isPopoutChatCommand,
  isValidPopoutChatSessionId,
  readPopoutChatSession,
} from '../src/utils/popoutChat.ts';

describe('pop-out chat utilities', () => {
  it('creates bounded random session ids for local chat windows', () => {
    const sessionId = createPopoutChatSessionId();

    assert.equal(sessionId.length, 24);
    assert.equal(isValidPopoutChatSessionId(sessionId), true);
    assert.equal(isValidPopoutChatSessionId('not-a-session'), false);
  });

  it('builds encoded pop-out chat urls and channel names', () => {
    const sessionId = '0123456789abcdef01234567';

    assert.equal(
      buildPopoutChatUrl('https://studio.example.com/', 'room with space', sessionId),
      'https://studio.example.com/studio/room%20with%20space/popout-chat?session=0123456789abcdef01234567'
    );
    assert.equal(
      getPopoutChatChannelName('room with space', sessionId),
      'livestream-studio:popout-chat:room%20with%20space:0123456789abcdef01234567'
    );
  });

  it('reads only valid session ids from query strings', () => {
    const sessionId = '0123456789abcdef01234567';

    assert.equal(readPopoutChatSession(`?session=${sessionId}`), sessionId);
    assert.equal(readPopoutChatSession('?session=short'), '');
    assert.equal(readPopoutChatSession('?session=0123456789abcdef0123456z'), '');
  });

  it('accepts only known host commands', () => {
    assert.equal(isPopoutChatCommand({ type: 'ready' }), true);
    assert.equal(isPopoutChatCommand({ type: 'request-state' }), true);
    assert.equal(isPopoutChatCommand({ type: 'send-message', payload: { content: 'Hello', isBackstage: false } }), true);
    assert.equal(isPopoutChatCommand({ type: 'react', payload: { messageId: 'm1', reaction: 'love' } }), true);
    assert.equal(isPopoutChatCommand({ type: 'toggle-star', payload: { messageId: 'm1', starred: true } }), true);
    assert.equal(isPopoutChatCommand({ type: 'toggle-pin', payload: { messageId: 'm1', pinned: true } }), true);

    assert.equal(isPopoutChatCommand({ type: 'send-message', payload: { content: '', isBackstage: false } }), false);
    assert.equal(isPopoutChatCommand({ type: 'react', payload: { messageId: 'm1', reaction: 'unknown' } }), false);
    assert.equal(isPopoutChatCommand({ type: 'toggle-star', payload: { messageId: 'm1', starred: 'yes' } }), false);
    assert.equal(isPopoutChatCommand({ type: 'toggle-pin', payload: { messageId: 'm1', pinned: 'yes' } }), false);
  });
});
