import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@studio/shared';
import { ChatMessageItem } from '../src/components/ChatMessageItem.tsx';
import {
  getChatDraftKey,
  getStudioChatMessages,
  isPublicChatMessage,
  prepareStudioChatMessage,
} from '../src/utils/chatWorkspace.ts';

const publicMessage: ChatMessage = {
  id: 'public-1', senderId: 'guest-1', senderName: 'Guest', content: 'Hello everyone',
  timestamp: '2026-09-06T06:00:00.000Z', isBackstage: false,
};
const backstageMessage: ChatMessage = {
  ...publicMessage, id: 'backstage-1', content: 'Private production cue', isBackstage: true,
};
const directMessage: ChatMessage = {
  ...publicMessage, id: 'direct-1', recipientId: 'host', recipientName: 'Host', content: 'Private note',
};

describe('chat workspace privacy and composition', () => {
  it('keeps public, backstage, and each recipient draft in a separate destination', () => {
    const destinations = [
      getChatDraftKey('public'), getChatDraftKey('backstage'), getChatDraftKey('direct', 'guest-1'),
      getChatDraftKey('direct', 'guest-2'), getChatDraftKey('direct', 'public'),
    ];
    assert.equal(new Set(destinations).size, destinations.length);
    const savedDrafts = Object.fromEntries(destinations.map((key, index) => [key, `draft ${index}`]));
    assert.equal(savedDrafts[getChatDraftKey('backstage')], 'draft 1');
    assert.equal(savedDrafts[getChatDraftKey('direct', 'guest-1')], 'draft 2');
    assert.equal(savedDrafts[getChatDraftKey('public')], 'draft 0');
  });

  it('never turns a direct draft into public chat when its recipient has left', () => {
    assert.deepEqual(prepareStudioChatMessage('  Private note  ', 'direct', 'guest-1', ['guest-1']), {
      content: 'Private note', isBackstage: false, recipientId: 'guest-1',
    });
    assert.equal(prepareStudioChatMessage('Private note', 'direct', 'guest-1', []), null);
    assert.equal(prepareStudioChatMessage('Private note', 'direct', '', ['guest-1']), null);
  });

  it('keeps social and starred views read-only', () => {
    assert.equal(prepareStudioChatMessage('Must not silently send publicly', 'social', '', []), null);
    assert.equal(prepareStudioChatMessage('Must not silently send publicly', 'starred', '', []), null);
  });

  it('preserves backstage scope and ignores irrelevant recipients for public messages', () => {
    assert.deepEqual(prepareStudioChatMessage('Cue the guest', 'backstage', '', []), { content: 'Cue the guest', isBackstage: true });
    assert.deepEqual(prepareStudioChatMessage('Welcome', 'public', 'old-recipient', []), { content: 'Welcome', isBackstage: false });
  });

  it('rejects empty messages and enforces the server message limit', () => {
    assert.equal(prepareStudioChatMessage(' \n ', 'public', '', []), null);
    assert.equal(prepareStudioChatMessage('a'.repeat(2001), 'public', '', []), null);
    assert.equal(prepareStudioChatMessage('a'.repeat(2000), 'public', '', [])?.content.length, 2000);
  });

  it('excludes private and backstage messages from public, social, and starred views', () => {
    const messages = [publicMessage, { ...backstageMessage, starred: true, source: { platform: 'youtube' as const, externalId: 'private-youtube' } }, { ...directMessage, starred: true, source: { platform: 'facebook' as const, externalId: 'private-facebook' } }];
    assert.deepEqual(getStudioChatMessages(messages, 'public', 'host').map(message => message.id), ['public-1']);
    assert.deepEqual(getStudioChatMessages(messages, 'social', 'host'), []);
    assert.deepEqual(getStudioChatMessages(messages, 'starred', 'host'), []);
  });

  it('shows only the signed-in participant’s direct inbox and selected conversation', () => {
    const outgoing: ChatMessage = { ...directMessage, id: 'outgoing', senderId: 'host', recipientId: 'guest-1' };
    const otherConversation: ChatMessage = { ...directMessage, id: 'other-guest', senderId: 'guest-2' };
    const unrelated: ChatMessage = { ...directMessage, id: 'unrelated', senderId: 'guest-2', recipientId: 'other-host' };
    const messages = [publicMessage, directMessage, outgoing, otherConversation, unrelated, backstageMessage];
    assert.deepEqual(getStudioChatMessages(messages, 'direct', 'host').map(message => message.id), ['direct-1', 'outgoing', 'other-guest']);
    assert.deepEqual(getStudioChatMessages(messages, 'direct', 'host', 'guest-1').map(message => message.id), ['direct-1', 'outgoing']);
    assert.deepEqual(getStudioChatMessages(messages, 'direct', 'outsider'), []);
  });

  it('only public messages qualify for broadcast actions', () => {
    assert.equal(isPublicChatMessage(publicMessage), true);
    assert.equal(isPublicChatMessage(backstageMessage), false);
    assert.equal(isPublicChatMessage(directMessage), false);
  });
});

describe('chat message actions', () => {
  const actionProps = {
    onReact: () => {}, onToggleStar: () => {}, onTogglePin: () => {},
    onFeature: () => {}, onFlash: () => {},
  };

  it('never offers broadcast actions for private or backstage messages even with all callbacks supplied', () => {
    for (const message of [directMessage, backstageMessage]) {
      const markup = renderToStaticMarkup(createElement(ChatMessageItem, { message, ...actionProps }));
      assert.doesNotMatch(markup, /Show on stage|Show briefly|Pin message|Star message/);
      assert.match(markup, /Like reaction/);
    }
  });

  it('keeps public broadcast controls available inside message options', () => {
    const markup = renderToStaticMarkup(createElement(ChatMessageItem, { message: publicMessage, ...actionProps }));
    assert.match(markup, /Show on stage/);
    assert.match(markup, /Show briefly/);
    assert.match(markup, /Pin message/);
    assert.match(markup, /Star message/);
    assert.match(markup, /<details/);
  });

  it('does not show unavailable actions to read-only viewers', () => {
    const markup = renderToStaticMarkup(createElement(ChatMessageItem, { message: publicMessage }));
    assert.doesNotMatch(markup, /<details/);
    assert.doesNotMatch(markup, /Show on stage|Pin message|Star message/);
    assert.match(markup, /Hello everyone/);
  });
});
