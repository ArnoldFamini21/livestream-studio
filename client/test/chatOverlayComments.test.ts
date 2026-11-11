import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '@studio/shared';
import {
  CHAT_OVERLAY_BUFFER_MAX,
  CHAT_OVERLAY_MAX_TEXT,
  sanitizeOverlayText,
  selectOverlayComments,
} from '../src/utils/chatOverlayComments.ts';

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const NEL = String.fromCharCode(0x85);
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
const RLM = String.fromCharCode(0x200f);
const ZWSP = String.fromCharCode(0x200b);

let counter = 0;
function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  counter += 1;
  return {
    id: `m${counter}`,
    senderId: 'guest-1',
    senderName: 'Maria',
    content: `Hello ${counter}`,
    timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0, counter)).toISOString(),
    isBackstage: false,
    ...overrides,
  };
}

const base = { mode: 'all' as const, paused: false, pausedIds: [], hiddenIds: [], shownIds: [] };
const select = (messages: ChatMessage[], settings = base, greenRoomIds = new Set<string>()) =>
  selectOverlayComments({ messages, settings, greenRoomIds });

describe('overlay privacy', () => {
  it('never lets backstage chat reach the overlay', () => {
    const result = select([message({ content: 'public' }), message({ content: 'secret producer note', isBackstage: true })]);
    assert.deepEqual(result.map((c) => c.text), ['public']);
  });

  it('never lets private or direct messages reach the overlay', () => {
    const result = select([
      message({ content: 'public' }),
      message({ content: 'for your eyes only', recipientId: 'host-1', recipientName: 'Arnold' }),
      message({ content: 'private and backstage', recipientId: 'host-1', isBackstage: true }),
    ]);
    assert.deepEqual(result.map((c) => c.text), ['public']);
  });

  it('never shows anything sent by someone who is still in the green room', () => {
    const result = select(
      [message({ content: 'from the green room', senderId: 'waiting' }), message({ content: 'from the stage', senderId: 'staged' })],
      base,
      new Set(['waiting']),
    );
    assert.deepEqual(result.map((c) => c.text), ['from the stage']);
  });

  it('keeps public platform comments, tagged with their source', () => {
    const result = select([
      message({ content: 'from youtube', senderId: 'yt:1', source: { platform: 'youtube', externalId: 'a' } }),
      message({ content: 'from facebook', senderId: 'fb:1', source: { platform: 'facebook', externalId: 'b' } }),
    ]);
    assert.deepEqual(result.map((c) => c.source), ['youtube', 'facebook']);
  });
});

describe('overlay text safety', () => {
  it('removes control and bidirectional override characters and keeps plain text', () => {
    const evil = ['Hi', NUL, ' ', RLO, 'evil', PDF, ' ', LRI, 'x', PDI, ' ', RLM, 'ok', ZWSP, BEL, ' ', NEL, 'done'].join('');
    const text = sanitizeOverlayText(evil);
    assert.equal(text, 'Hi evil x ok done');
    for (const bad of [NUL, BEL, NEL, RLO, PDF, LRI, PDI, RLM, ZWSP]) assert.equal(text.includes(bad), false);
  });

  it('flattens line breaks and keeps markup as inert text', () => {
    assert.equal(sanitizeOverlayText('line one\r\nline two\n\n<b>bold</b> <script>alert(1)</script>'), 'line one line two <b>bold</b> <script>alert(1)</script>');
  });

  it('caps the length at about 200 characters with an ellipsis', () => {
    const text = sanitizeOverlayText('word '.repeat(500));
    assert.ok(Array.from(text).length <= CHAT_OVERLAY_MAX_TEXT);
    assert.ok(text.endsWith(String.fromCharCode(0x2026)));
    assert.equal(sanitizeOverlayText('short'), 'short');
    assert.equal(sanitizeOverlayText('x'.repeat(300)).length, CHAT_OVERLAY_MAX_TEXT);
    assert.ok(Array.from(sanitizeOverlayText('\ud83d\ude00'.repeat(300))).length <= CHAT_OVERLAY_MAX_TEXT);
  });

  it('turns non-strings and empty text into nothing, and drops empty comments', () => {
    assert.equal(sanitizeOverlayText(undefined), '');
    assert.equal(sanitizeOverlayText({}), '');
    assert.deepEqual(select([message({ content: [RLO, ZWSP, '  '].join('') })]), []);
  });

  it('sanitizes the author too', () => {
    const [comment] = select([message({ senderName: ('Mal' + RLO + 'lory' + NUL + ' ').repeat(20) })]);
    assert.ok(comment.author.length <= 40);
    assert.equal(comment.author.includes(RLO) || comment.author.includes(NUL), false);
  });
});

describe('overlay buffer', () => {
  it('keeps a bounded number of the newest comments, oldest first', () => {
    const many = Array.from({ length: 500 }, (_, i) => message({ content: `c${i}` }));
    const result = select(many);
    assert.equal(result.length, CHAT_OVERLAY_BUFFER_MAX);
    assert.equal(result.at(-1)!.text, 'c499');
    assert.equal(result[0].text, `c${500 - CHAT_OVERLAY_BUFFER_MAX}`);
  });

  it('orders by comment time, so a late-arriving older platform comment sits where it belongs', () => {
    const late = message({ content: 'older', timestamp: '2026-11-01T09:00:00.000Z' });
    const result = select([message({ content: 'newer' }), late]);
    assert.deepEqual(result.map((c) => c.text), ['older', 'newer']);
  });
});

describe('overlay modes and host controls', () => {
  it('approved mode shows only starred or shown-on-screen comments', () => {
    const plain = message({ content: 'plain' });
    const starred = message({ content: 'starred', starred: true });
    const shown = message({ content: 'shown' });
    const result = select([plain, starred, shown], { ...base, mode: 'approved', shownIds: [shown.id] });
    assert.deepEqual(result.map((c) => c.text), ['starred', 'shown']);
  });

  it('all mode shows every public comment automatically', () => {
    assert.equal(select([message(), message(), message()]).length, 3);
  });

  it('hides one comment from the overlay only', () => {
    const a = message({ content: 'a' });
    const b = message({ content: 'b' });
    assert.deepEqual(select([a, b], { ...base, hiddenIds: [a.id] }).map((c) => c.text), ['b']);
  });

  it('pause freezes the shown comments while new ones arrive, and still honors privacy and hiding', () => {
    const a = message({ content: 'a' });
    const b = message({ content: 'b' });
    const later = message({ content: 'later' });
    const priv = message({ content: 'private', recipientId: 'x' });
    const frozen = { ...base, paused: true, pausedIds: [a.id, b.id, priv.id], hiddenIds: [b.id] };
    assert.deepEqual(select([a, b, later, priv], frozen).map((c) => c.text), ['a']);
  });

  it('marks questions on the sanitized text', () => {
    const [q, s] = select([message({ content: 'What time is the sermon?' }), message({ content: 'Amen' })]);
    assert.equal(q.question, true);
    assert.equal(s.question, false);
  });
});
