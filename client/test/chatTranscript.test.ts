import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '@studio/shared';
import {
  buildChatTranscriptCsv,
  buildChatTranscriptFilename,
  buildChatTranscriptTxt,
  getChatTranscriptMessages,
  guardSpreadsheetFormula,
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
    source: {
      platform: 'facebook',
      externalId: 'fb-comment-1',
    },
  },
  {
    id: 'public-early',
    senderId: 'guest-1',
    senderName: 'Ari',
    content: 'Hello, "team"\nGreat demo',
    timestamp: '2026-06-11T10:01:00.000Z',
    isBackstage: false,
    source: {
      platform: 'youtube',
      externalId: 'yt-message-1',
    },
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
    assert.match(csv, /^"Time","Source","Author","Message","Question","Shown on screen",/);
    assert.match(csv, /"youtube","Ari"/);
    assert.match(csv, /"facebook","Mia"/);
    assert.match(csv, /"yt-message-1"/);
    assert.match(csv, /"fb-comment-1"/);
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

  it('exports imported social comments as their own operator inbox', () => {
    assert.deepEqual(
      getChatTranscriptMessages(messages, 'social').map((message) => message.id),
      ['public-early', 'public-late']
    );

    const csv = buildChatTranscriptCsv(messages, 'social');

    assert.match(csv, /"Social","yt-message-1"/);
    assert.match(csv, /"Social","fb-comment-1"/);
    assert.doesNotMatch(csv, /Guest mic is hot/);
    assert.doesNotMatch(csv, /You are next/);
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
      buildChatTranscriptFilename('social', new Date('2026-06-11T10:05:30.000Z')),
      'studio_chat_social_2026-06-11_10-05.csv'
    );
  });

  it('names txt exports like csv ones', () => {
    assert.equal(
      buildChatTranscriptFilename('public', new Date('2026-06-11T10:05:30.000Z'), 'txt'),
      'studio_chat_public_2026-06-11_10-05.txt'
    );
  });
});

describe('chat history export (csv and txt)', () => {
  const parse = (csv: string) => csv.trimEnd().split('\r\n');

  it('puts time, source, author, message, question and shown-on-screen first, one row per public comment', () => {
    const csv = buildChatTranscriptCsv(messages, 'public', { shownIds: ['public-early'] });
    const [header, early, late] = parse(csv);
    assert.ok(header.startsWith('"Time","Source","Author","Message","Question","Shown on screen"'));
    assert.ok(early.startsWith('"2026-06-11T10:01:00.000Z","youtube","Ari","Hello, ""team""\nGreat demo","No","Yes",'), early);
    assert.ok(late.startsWith('"2026-06-11T10:05:00.000Z","facebook","Mia","Can you show the pricing slide?","Yes","No",'), late);
  });

  it('marks questions and shown comments, and defaults to nothing shown', () => {
    const csv = buildChatTranscriptCsv(messages, 'public');
    assert.match(csv, /pricing slide\?","Yes","No"/);
  });

  it('keeps studio comments labeled studio', () => {
    const studio: ChatMessage = { ...messages[2], id: 'studio-1', source: undefined, content: 'Hi all' };
    assert.match(buildChatTranscriptCsv([studio], 'public'), /"2026-06-11T10:01:00.000Z","studio","Ari","Hi all"/);
  });

  it('prefixes cells that start with = + - or @ so a spreadsheet never runs them', () => {
    for (const evil of ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=cmd']) {
      assert.equal(guardSpreadsheetFormula(evil), `'${evil}`);
    }
    assert.equal(guardSpreadsheetFormula('hello = world'), 'hello = world');
    assert.equal(guardSpreadsheetFormula('5 - 3'), '5 - 3');
    const attack: ChatMessage = { ...messages[2], id: 'x', senderName: '=1+1', content: '@SUM(1)' };
    const [, row] = parse(buildChatTranscriptCsv([attack], 'public'));
    assert.match(row, /,"'=1\+1","'@SUM\(1\)",/);
  });

  it('escapes quotes, commas and line breaks inside cells', () => {
    const tricky: ChatMessage = { ...messages[2], id: 'q', content: 'He said "hi", then\nleft' };
    assert.ok(buildChatTranscriptCsv([tricky], 'public').includes('"He said ""hi"", then\nleft"'));
  });

  it('writes a text transcript with time, source, author, message and markers', () => {
    const txt = buildChatTranscriptTxt(messages, 'public', { shownIds: ['public-early'] });
    assert.equal(txt, [
      '[2026-06-11T10:01:00.000Z] (youtube) Ari: Hello, "team"',
      '    Great demo [shown on screen]',
      '[2026-06-11T10:05:00.000Z] (facebook) Mia: Can you show the pricing slide? [question]',
      '',
    ].join('\n'));
    assert.equal(buildChatTranscriptTxt([], 'public'), '');
    assert.doesNotMatch(txt, /Guest mic is hot|You are next/);
  });
});
