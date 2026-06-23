import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '@studio/shared';
import {
  buildChatTranscriptCsv,
  buildChatTranscriptFilename,
  getChatTranscriptMessages,
} from '../src/utils/chatTranscript.ts';

const messages: ChatMessage[] = [
  {
    id: 'backstage-note',
    senderId: 'producer-1',
    senderName: 'Producer',
    content: 'Guest mic is hot',
    timestamp: '2026-06-11T10:02:00.000Z',
    isBackstage: true,
  },
  {
    id: 'public-late',
    senderId: 'guest-2',
    senderName: 'Mia',
    content: 'Can you show the pricing slide?',
    timestamp: '2026-06-11T10:05:00.000Z',
    isBackstage: false,
    pinned: true,
    starred: true,
    reactions: { like: 2, clap: 1 },
  },
  {
    id: 'public-early',
    senderId: 'guest-1',
    senderName: 'Ari',
    content: 'Hello, "team"\nGreat demo',
    timestamp: '2026-06-11T10:01:00.000Z',
    isBackstage: false,
  },
  {
    id: 'direct-note',
    senderId: 'host-1',
    senderName: 'Host',
    recipientId: 'guest-1',
    recipientName: 'Ari',
    content: 'You are next',
    timestamp: '2026-06-11T10:03:00.000Z',
    isBackstage: false,
  },
];

describe('chat transcript export', () => {
  it('exports public chat without backstage producer notes', () => {
    assert.deepEqual(
      getChatTranscriptMessages(messages, 'public').map((message) => message.id),
      ['public-early', 'public-late']
    );

    const csv = buildChatTranscriptCsv(messages, 'public');

    assert.match(csv, /"Ari"/);
    assert.match(csv, /"Hello, ""team""\nGreat demo"/);
    assert.match(csv, /"Pinned","Starred"/);
    assert.match(csv, /"Like: 2; Clap: 1"/);
    assert.doesNotMatch(csv, /Guest mic is hot/);
    assert.doesNotMatch(csv, /You are next/);
  });

  it('exports only starred public comments for producer follow-up', () => {
    assert.deepEqual(
      getChatTranscriptMessages(messages, 'starred').map((message) => message.id),
      ['public-late']
    );
  });

  it('exports backstage notes only when that scope is requested', () => {
    const csv = buildChatTranscriptCsv(messages, 'backstage');

    assert.match(csv, /"Backstage"/);
    assert.match(csv, /"Guest mic is hot"/);
    assert.doesNotMatch(csv, /pricing slide/);
  });

  it('exports direct messages only when that scope is requested', () => {
    assert.deepEqual(
      getChatTranscriptMessages(messages, 'direct').map((message) => message.id),
      ['direct-note']
    );

    const csv = buildChatTranscriptCsv(messages, 'direct');

    assert.match(csv, /"Direct"/);
    assert.match(csv, /"Ari"/);
    assert.match(csv, /"You are next"/);
    assert.doesNotMatch(csv, /pricing slide/);
  });

  it('builds deterministic csv filenames by scope', () => {
    assert.equal(
      buildChatTranscriptFilename('public', new Date('2026-06-11T10:05:30.000Z')),
      'studio_chat_public_2026-06-11_10-05.csv'
    );
  });
});
