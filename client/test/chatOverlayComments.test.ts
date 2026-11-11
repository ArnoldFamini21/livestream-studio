import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '@studio/shared';
import {
  CHAT_OVERLAY_BUFFER_MAX,
  CHAT_OVERLAY_MAX_TEXT,
  idsToFreeze,
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

describe('idsToFreeze', () => {
  it('freezes nothing when the overlay offers no comments (stale preview report)', () => {
    assert.deepEqual(idsToFreeze(['a', 'b'], []), []);
  });
  it('keeps only ids that are still offered, in the reported order', () => {
    assert.deepEqual(idsToFreeze(['a', 'b', 'c'], [{ id: 'c' }, { id: 'a' }]), ['a', 'c']);
  });
});

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ZWJ = cp(0x200d);
const ZWNJ = cp(0x200c);
const FAMILY = ['\u{1F468}', '\u{1F469}', '\u{1F467}'].join(ZWJ);
const HEART_ON_FIRE = ['\u2764\uFE0F', '\u{1F525}'].join(ZWJ);
const FLAG = '\u{1F1F5}\u{1F1ED}';
const PRAYING = '\u{1F64F}\u{1F3FD}';

describe('joiner characters', () => {
  it('keeps a family emoji and a heart on fire intact', () => {
    assert.equal(sanitizeOverlayText(`hi ${FAMILY}`), `hi ${FAMILY}`);
    assert.equal(sanitizeOverlayText(HEART_ON_FIRE), HEART_ON_FIRE);
  });

  it('removes a joiner next to a space, at the start and at the end', () => {
    assert.equal(sanitizeOverlayText(`a${ZWJ} b`), 'a b');
    assert.equal(sanitizeOverlayText(`a ${ZWNJ}b`), 'a b');
    assert.equal(sanitizeOverlayText(`a ${ZWJ} b`), 'a b');
    assert.equal(sanitizeOverlayText(`${ZWJ}ab`), 'ab');
    assert.equal(sanitizeOverlayText(`ab${ZWNJ}`), 'ab');
  });

  it('collapses a run of joiners to one', () => {
    assert.equal(sanitizeOverlayText(`a${ZWJ}${ZWNJ}${ZWJ}${ZWJ}b`), `a${ZWJ}b`);
  });

  it('keeps the non-joiner inside a Persian word', () => {
    const word = ['\u0645\u06CC', '\u062E\u0648\u0627\u0647\u0645'].join(ZWNJ);
    assert.equal(sanitizeOverlayText(`${word} \u062F\u0648\u0633\u062A`), `${word} \u062F\u0648\u0633\u062A`);
  });

  it('drops a text that holds only joiners', () => {
    assert.equal(sanitizeOverlayText(`${ZWJ}${ZWNJ}${ZWJ}`), '');
    assert.equal(sanitizeOverlayText(` ${ZWJ} `), '');
    assert.deepEqual(select([message({ content: `${ZWNJ}${ZWJ}` })]), []);
  });

  it('still removes every other invisible or directional character', () => {
    const removed = [
      0x0000, 0x0007, 0x001f, 0x007f, 0x0085, 0x009f, 0x00ad, 0x061c, 0x180e,
      0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
      0xfeff, 0xfff9, 0xfffa, 0xfffb,
    ];
    for (const code of removed) {
      assert.equal(sanitizeOverlayText(`a${cp(code)}b`), 'ab', `U+${code.toString(16)} must stay removed`);
    }
  });
});

describe('stacked combining marks', () => {
  it('keeps at most four marks in a row', () => {
    const marks = (count: number) => Array.from({ length: count }, (_, index) => cp(0x0300 + (index % 20))).join('');
    const text = sanitizeOverlayText(`Z${marks(40)}!`);
    assert.equal(text, `Z${marks(4)}!`);
    assert.equal(sanitizeOverlayText(`Z${marks(4)}`), `Z${marks(4)}`);
  });

  it('leaves Vietnamese, Thai and emoji with a variation selector alone', () => {
    const vietnamese = 'Vi\u1EC7t Nam, ti\u1EBFng Vi\u1EC7t'.normalize('NFD');
    assert.equal(sanitizeOverlayText(vietnamese), vietnamese);
    const thai = '\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35\u0E04\u0E23\u0E31\u0E1A \u0E19\u0E49\u0E33';
    assert.equal(sanitizeOverlayText(thai), thai);
    assert.equal(sanitizeOverlayText('\u2764\uFE0F'), '\u2764\uFE0F');
  });
});

describe('cutting at whole characters', () => {
  it('never cuts a run of flags in half, and keeps the 200 code point limit', () => {
    const text = sanitizeOverlayText(FLAG.repeat(300));
    assert.ok(Array.from(text).length <= CHAT_OVERLAY_MAX_TEXT);
    assert.ok(text.endsWith('\u2026'));
    assert.match(text.slice(0, -1), /^(?:\p{RI}\p{RI})+$/u);
  });

  it('never separates an emoji from its skin tone', () => {
    const text = sanitizeOverlayText(PRAYING.repeat(150));
    assert.ok(Array.from(text).length <= CHAT_OVERLAY_MAX_TEXT);
    assert.match(text.slice(0, -1), new RegExp(`^(?:${PRAYING})+$`, 'u'));
  });

  it('never ends inside a family emoji', () => {
    const text = sanitizeOverlayText(`${'x'.repeat(197)}${FAMILY}`);
    assert.equal(text, `${'x'.repeat(197)}\u2026`);
    assert.equal(text.includes(ZWJ), false);
    const many = sanitizeOverlayText(FAMILY.repeat(60));
    assert.match(many.slice(0, -1), new RegExp(`^(?:${FAMILY})+$`, 'u'));
  });
});
