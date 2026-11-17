import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VIEWER_FEED_MESSAGES_MAX,
  VIEWER_FEED_VISIBLE,
  VIEWER_MESSAGE_MAX,
  VIEWER_NAME_MAX,
  VIEWER_REACTION_RULES,
  VIEWER_TALK_RULES,
  appendFeedMessage,
  appendFeedReaction,
  checkRateRule,
  createRateLimiterState,
  createRequestRateMeter,
  createViewerFeed,
  defaultViewerChatSwitches,
  effectiveViewerPollMs,
  isPublicChatCandidate,
  isRepeatOfPrevious,
  isValidViewerId,
  isViewerReactionType,
  isWatchPublicStudioMessage,
  maskProfanity,
  noteRequest,
  normalizeViewerChatSwitches,
  normalizeViewerChatSwitchesPatch,
  readViewerFeed,
  removeFeedMessages,
  repeatKey,
  sanitizeViewerText,
  slowDownLine,
  suggestViewerPollMs,
  tryRecordAction,
} from '../dist/index.js';

const code = (...points) => String.fromCodePoint(...points);

describe('sanitizing viewer text', () => {
  it('trims, flattens and keeps plain text', () => {
    assert.deepEqual(sanitizeViewerText('  Hello \n  world\t!  ', VIEWER_MESSAGE_MAX), { ok: true, text: 'Hello world !' });
    assert.deepEqual(sanitizeViewerText('<b>bold</b> <script>alert(1)</script> https://example.com', VIEWER_MESSAGE_MAX).text, '<b>bold</b> <script>alert(1)</script> https://example.com');
  });

  it('refuses things that are not text, empty text and text that is too long (never cuts it)', () => {
    for (const bad of [undefined, null, 5, {}, ['a']]) assert.equal(sanitizeViewerText(bad, 10).reason, 'not-text');
    assert.equal(sanitizeViewerText('   \n\t ', 10).reason, 'empty');
    assert.equal(sanitizeViewerText('x'.repeat(11), 10).reason, 'too-long');
    assert.equal(sanitizeViewerText('x'.repeat(10), 10).ok, true);
    assert.equal(sanitizeViewerText('x'.repeat(100_000), 300).reason, 'too-long');
  });

  it('counts characters, not code units (an emoji is one)', () => {
    assert.equal(sanitizeViewerText(code(0x1f64f).repeat(300), 300).ok, true);
    assert.equal(sanitizeViewerText(code(0x1f64f).repeat(301), 300).reason, 'too-long');
  });

  it('removes control, direction-changing, zero-width and invisible filler characters', () => {
    const dirty = `Ho${code(0x202e)}st${code(0x200b)}${code(0x0)}${code(0x7)} ${code(0x3164)}Name${code(0xfeff)}`;
    assert.equal(sanitizeViewerText(dirty, 40).text, 'Host Name');
    assert.equal(sanitizeViewerText(`${code(0x3164)}${code(0x2800)}${code(0x200b)}`, 40).reason, 'empty', 'a name made of invisible letters is empty');
    assert.equal(sanitizeViewerText(`a${code(0xe0041, 0xe0042)}b`, 40).text, 'ab', 'tag characters are dropped');
    assert.equal(sanitizeViewerText(`one${code(0x2028)}two`, 40).text, 'one two');
  });

  it('keeps an emoji sequence joiner between two characters, drops a lone one, and limits stacked marks', () => {
    const family = `${code(0x1f469)}${code(0x200d)}${code(0x1f467)}`;
    assert.equal(sanitizeViewerText(family, 10).text, family);
    assert.equal(sanitizeViewerText(` ${code(0x200d)} a${code(0x200d)}`, 10).text, 'a');
    const stacked = `a${code(0x301).repeat(30)}`;
    assert.equal(Array.from(sanitizeViewerText(stacked, 40).text).length, 5);
  });

  it('does not turn a name into something else: the name limit is 40', () => {
    assert.equal(sanitizeViewerText('n'.repeat(VIEWER_NAME_MAX), VIEWER_NAME_MAX).ok, true);
    assert.equal(sanitizeViewerText('n'.repeat(VIEWER_NAME_MAX + 1), VIEWER_NAME_MAX).reason, 'too-long');
  });
});

describe('the word filter', () => {
  const mask = (text) => maskProfanity(text).text;

  it('masks whole listed words (English and Tagalog) with asterisks and keeps the rest', () => {
    assert.deepEqual(maskProfanity('What the fuck is this'), { text: 'What the **** is this', masked: true });
    assert.equal(mask('Gago ka talaga'), '**** ka talaga');
    assert.equal(mask('putangina mo'), '********* mo');
    assert.equal(maskProfanity('Amen, praise the Lord').masked, false);
    assert.equal(mask('Amen, praise the Lord'), 'Amen, praise the Lord');
  });

  it('ignores case, repeated letters and common look-alike characters', () => {
    assert.equal(mask('FUCK'), '****');
    assert.equal(mask('fuuuuck'), '*******');
    assert.equal(mask('fuuck'), '*****');
    assert.equal(mask('sh1t'), '****');
    assert.equal(mask('$hit'), '****');
    assert.equal(mask('sh!t'), '****');
    assert.equal(mask('b1tch'), '*****');
    assert.equal(mask('f' + code(0xfc) + 'ck'), '****');
    assert.equal(mask(code(0xff26, 0xff35, 0xff23, 0xff2b)), '****', 'full-width letters');
    assert.equal(mask('sh' + code(0x456) + 't'), '****', 'a Cyrillic i');
  });

  it('keeps punctuation next to a masked word', () => {
    assert.equal(mask('what a bitch!'), 'what a *****!');
    assert.equal(mask('shit!!!'), '****!!!');
    assert.equal(mask('(shit)'), '(****)');
  });

  it('matches whole words only', () => {
    for (const fine of ['class', 'assume', 'Scunthorpe', 'shitake', 'pass', 'cocktail', 'analysis', 'bass', 'title', 'Dickens', 'cucumber', 'mother']) {
      assert.equal(maskProfanity(fine).masked, false, fine);
    }
  });

  it('leaves words with an ordinary or biblical use alone, and numbers', () => {
    for (const fine of ['hell', 'damn', 'ass', 'cock', 'Balaam rode an ass', 'the cock crowed', 'whore', 'bastard', 'Psalm 455', '455', '1 Corinthians 13:4', '5000 people', 'Dick']) {
      assert.equal(maskProfanity(fine).masked, false, fine);
    }
  });

  it('works on every word of a long text and never drops text', () => {
    const text = 'good gago bad, SHIT; fine.';
    assert.equal(mask(text), 'good **** bad, ****; fine.');
    assert.equal(mask(text).length, text.length);
  });
});

describe('repeated messages', () => {
  it('says the same message twice in a row is a repeat, whatever the case or spacing', () => {
    const key = repeatKey('God is good!');
    assert.equal(isRepeatOfPrevious(key, 'god is   GOOD'), true);
    assert.equal(isRepeatOfPrevious(key, 'God is good again'), false);
    assert.equal(isRepeatOfPrevious(undefined, 'anything'), false);
    assert.equal(isRepeatOfPrevious(repeatKey(code(0x1f64f)), code(0x1f64f)), true);
  });
});

describe('rate limits', () => {
  const who = (viewer, network = 'net') => ({ viewerId: viewer.padEnd(16, 'x'), networkKey: network });

  it('allows one message every 2 seconds and 5 in 30 seconds per viewer, with the clock passed in', () => {
    const state = createRateLimiterState();
    const rules = VIEWER_TALK_RULES;
    assert.equal(tryRecordAction(state, who('a'), 0, rules).allowed, true);
    const tooSoon = tryRecordAction(state, who('a'), 1000, rules);
    assert.deepEqual(tooSoon, { allowed: false, scope: 'viewer', retryAfterMs: 1000 });
    assert.equal(tryRecordAction(state, who('a'), 2000, rules).allowed, true);
    assert.equal(tryRecordAction(state, who('a'), 4000, rules).allowed, true);
    assert.equal(tryRecordAction(state, who('a'), 6000, rules).allowed, true);
    assert.equal(tryRecordAction(state, who('a'), 8000, rules).allowed, true);
    const fifth = tryRecordAction(state, who('a'), 10_000, rules);
    assert.equal(fifth.allowed, false, 'a sixth message inside 30 seconds');
    assert.equal(fifth.retryAfterMs, 20_000, 'waits until the first one leaves the 30 second window');
    assert.equal(tryRecordAction(state, who('a'), 30_000, rules).allowed, true);
  });

  it('a refused attempt costs nothing', () => {
    const state = createRateLimiterState();
    tryRecordAction(state, who('a'), 0, VIEWER_TALK_RULES);
    for (let t = 100; t < 1900; t += 100) assert.equal(tryRecordAction(state, who('a'), t, VIEWER_TALK_RULES).allowed, false);
    assert.equal(tryRecordAction(state, who('a'), 2000, VIEWER_TALK_RULES).allowed, true, 'still free right on time');
  });

  it('lets a whole congregation behind one network write, up to 30 in 30 seconds', () => {
    const state = createRateLimiterState();
    for (let i = 0; i < 30; i += 1) assert.equal(tryRecordAction(state, who(`viewer${i}`, 'church'), 1000 + i, VIEWER_TALK_RULES).allowed, true, `viewer ${i}`);
    const thirtyFirst = tryRecordAction(state, who('viewer99', 'church'), 1100, VIEWER_TALK_RULES);
    assert.equal(thirtyFirst.allowed, false);
    assert.equal(thirtyFirst.scope, 'network');
    assert.equal(tryRecordAction(state, who('viewer99', 'home'), 1100, VIEWER_TALK_RULES).allowed, true, 'another network is not affected');
  });

  it('has a room-wide ceiling', () => {
    const state = createRateLimiterState();
    let allowed = 0;
    for (let i = 0; i < 200; i += 1) {
      if (tryRecordAction(state, who(`v${i}`, `n${i}`), 5000 + i, VIEWER_TALK_RULES).allowed) allowed += 1;
    }
    assert.equal(allowed, VIEWER_TALK_RULES.room.max);
    const refused = tryRecordAction(state, who('late', 'late'), 5300, VIEWER_TALK_RULES);
    assert.equal(refused.allowed, false);
    assert.equal(refused.scope, 'room');
    assert.equal(tryRecordAction(state, who('later', 'later'), 5000 + 30_001, VIEWER_TALK_RULES).allowed, true, 'the window moves on');
  });

  it('keeps reactions on their own, looser budget', () => {
    const state = createRateLimiterState();
    assert.equal(tryRecordAction(state, who('a'), 0, VIEWER_REACTION_RULES).allowed, true);
    assert.equal(tryRecordAction(state, who('a'), 200, VIEWER_REACTION_RULES).allowed, false);
    assert.equal(tryRecordAction(state, who('a'), 400, VIEWER_REACTION_RULES).allowed, true);
  });

  it('checks one rule from a history and ignores a clock that went backwards', () => {
    const rule = { minGapMs: 0, max: 2, windowMs: 1000 };
    assert.equal(checkRateRule([100, 200], 300, rule).allowed, false);
    assert.equal(checkRateRule([100, 200], 1150, rule).allowed, true);
    assert.equal(checkRateRule(undefined, 0, rule).allowed, true);
    assert.equal(checkRateRule([5000], 100, { minGapMs: 2000, max: 5, windowMs: 30_000 }).allowed, true, 'a future entry is not counted');
  });

  it('keeps its memory bounded', () => {
    const state = createRateLimiterState();
    const loose = { viewer: { minGapMs: 0, max: 5, windowMs: 1e9 }, network: { minGapMs: 0, max: 1e9, windowMs: 1e9 }, room: { minGapMs: 0, max: 1e9, windowMs: 1e9 } };
    for (let i = 0; i < 6000; i += 1) tryRecordAction(state, who(`v${i}`, `n${i}`), i, loose);
    assert.ok(state.viewers.size <= 5000);
    assert.ok(state.networks.size <= 5000);
  });

  it('asks a viewer to slow down in a plain line', () => {
    assert.equal(slowDownLine(400), 'Please slow down. You can send again in 1 second.');
    assert.equal(slowDownLine(2300), 'Please slow down. You can send again in 3 seconds.');
  });
});

describe('which studio messages the watch page may show', () => {
  const base = { isBackstage: false };
  const inRoom = { senderInGreenRoom: false };

  it('uses the overlay rule (public only, not from the green room) and then only the studio\'s own words', () => {
    assert.equal(isWatchPublicStudioMessage({ ...base }, inRoom), true);
    assert.equal(isWatchPublicStudioMessage({ isBackstage: true }, inRoom), false, 'backstage is private');
    assert.equal(isWatchPublicStudioMessage({ ...base, recipientId: 'p1' }, inRoom), false, 'a private message');
    assert.equal(isWatchPublicStudioMessage({ ...base }, { senderInGreenRoom: true }), false, 'someone still waiting in the green room');
    assert.equal(isWatchPublicStudioMessage({ ...base, source: { platform: 'youtube', externalId: 'x' } }, inRoom), false, 'a YouTube comment');
    assert.equal(isWatchPublicStudioMessage({ ...base, source: { platform: 'facebook', externalId: 'x' } }, inRoom), false);
    assert.equal(isWatchPublicStudioMessage({ ...base, source: { platform: 'watch', externalId: 'x' } }, inRoom), false, 'viewer messages have their own entry');
  });

  it('is built on the same public rule the on-screen overlay uses', () => {
    assert.equal(isPublicChatCandidate({ isBackstage: false }), true);
    assert.equal(isPublicChatCandidate({ isBackstage: true }), false);
    assert.equal(isPublicChatCandidate({ isBackstage: false, recipientId: 'x' }), false);
  });
});

describe('the feed and its cursor', () => {
  const add = (feed, id, extra = {}) => appendFeedMessage(feed, { id, from: 'viewer', name: 'Ana', text: `text ${id}`, at: 1, ...extra });

  it('answers a first visit with the recent list and a cursor', () => {
    const feed = createViewerFeed('e1');
    add(feed, 'm1');
    add(feed, 'm2');
    const first = readViewerFeed(feed, {});
    assert.equal(first.reset, true);
    assert.deepEqual(first.messages.map((m) => m.id), ['m1', 'm2']);
    assert.equal(first.cursor, 2);
    assert.equal(first.epoch, 'e1');
  });

  it('is cheap when nothing changed: no messages, no removals, same cursor', () => {
    const feed = createViewerFeed('e1');
    add(feed, 'm1');
    const quiet = readViewerFeed(feed, { after: '1', epoch: 'e1' });
    assert.deepEqual(quiet, { epoch: 'e1', cursor: 1, reset: false, messages: [], removed: [], reactions: {} });
  });

  it('sends only what is new, oldest first', () => {
    const feed = createViewerFeed('e1');
    add(feed, 'm1');
    const seen = readViewerFeed(feed, { epoch: 'e1' }).cursor;
    add(feed, 'm2');
    add(feed, 'm3');
    const next = readViewerFeed(feed, { after: String(seen), epoch: 'e1' });
    assert.equal(next.reset, false);
    assert.deepEqual(next.messages.map((m) => m.id), ['m2', 'm3']);
  });

  it('never carries an id, a key or who moderated', () => {
    const feed = createViewerFeed('e1');
    add(feed, 'm1', { ref: 'secret-handle' });
    const wire = JSON.stringify(readViewerFeed(feed, {}));
    assert.equal(wire.includes('secret-handle'), false);
    assert.deepEqual(Object.keys(readViewerFeed(feed, {}).messages[0]).sort(), ['at', 'from', 'id', 'name', 'text']);
  });

  it('tells pages about removals, and a new page never gets a removed message', () => {
    const feed = createViewerFeed('e1');
    add(feed, 'm1', { ref: 'h1' });
    add(feed, 'm2', { ref: 'h2' });
    const cursor = readViewerFeed(feed, { epoch: 'e1' }).cursor;
    assert.deepEqual(removeFeedMessages(feed, (m) => m.ref === 'h1'), ['m1']);
    assert.deepEqual(readViewerFeed(feed, { after: String(cursor), epoch: 'e1' }).removed, ['m1']);
    assert.deepEqual(readViewerFeed(feed, {}).messages.map((m) => m.id), ['m2']);
    assert.deepEqual(removeFeedMessages(feed, () => false), []);
  });

  it('starts over when the epoch differs, the cursor is from the future or not a number', () => {
    const feed = createViewerFeed('e2');
    add(feed, 'm1');
    assert.equal(readViewerFeed(feed, { after: '1', epoch: 'e1' }).reset, true, 'the server restarted');
    assert.equal(readViewerFeed(feed, { after: '99', epoch: 'e2' }).reset, true, 'a cursor from another life');
    for (const junk of ['abc', '-1', '1.5', '', '1e9', '99999999999999999999', {}, [], null]) {
      assert.equal(readViewerFeed(feed, { after: junk, epoch: 'e2' }).reset, true, String(junk));
    }
    assert.equal(readViewerFeed(feed, { after: 0, epoch: 'e2' }).reset, false, 'a real number works too');
  });

  it('starts over for a page that fell behind more than it holds, or past what is kept', () => {
    const feed = createViewerFeed('e1');
    for (let i = 0; i < VIEWER_FEED_VISIBLE + 5; i += 1) add(feed, `m${i}`);
    const behind = readViewerFeed(feed, { after: '1', epoch: 'e1' });
    assert.equal(behind.reset, true);
    assert.equal(behind.messages.length, VIEWER_FEED_VISIBLE, 'about the last 100');
    assert.equal(behind.messages[behind.messages.length - 1].id, `m${VIEWER_FEED_VISIBLE + 4}`, 'newest at the bottom');

    const small = createViewerFeed('e3');
    for (let i = 0; i < VIEWER_FEED_MESSAGES_MAX + 10; i += 1) add(small, `n${i}`);
    assert.equal(small.messages.length, VIEWER_FEED_MESSAGES_MAX, 'memory is bounded');
    assert.equal(readViewerFeed(small, { after: '5', epoch: 'e3' }).reset, true, 'the cursor is older than what is kept');
    assert.equal(readViewerFeed(small, { after: String(small.seq - 1), epoch: 'e3' }).reset, false);
  });

  it('counts reactions since the cursor and never sends names', () => {
    const feed = createViewerFeed('e1');
    appendFeedReaction(feed, 'like');
    const cursor = readViewerFeed(feed, { epoch: 'e1' }).cursor;
    appendFeedReaction(feed, 'love');
    appendFeedReaction(feed, 'love');
    appendFeedReaction(feed, 'clap');
    const next = readViewerFeed(feed, { after: String(cursor), epoch: 'e1' });
    assert.deepEqual(next.reactions, { love: 2, clap: 1 });
    assert.deepEqual(readViewerFeed(feed, {}).reactions, {}, 'a fresh page does not replay old reactions');
  });

  it('keeps its reaction memory bounded', () => {
    const feed = createViewerFeed('e1');
    for (let i = 0; i < 1000; i += 1) appendFeedReaction(feed, 'like');
    assert.ok(feed.reactions.length <= 120);
  });
});

describe('switches, ids and reactions', () => {
  it('starts with everything off', () => {
    assert.deepEqual(defaultViewerChatSwitches(), { chat: false, reactions: false, questions: false });
    assert.deepEqual(normalizeViewerChatSwitches(undefined), { chat: false, reactions: false, questions: false });
    assert.deepEqual(normalizeViewerChatSwitches({ chat: 'yes', reactions: 1, questions: true }), { chat: false, reactions: false, questions: true });
  });

  it('takes only real booleans in a change', () => {
    assert.deepEqual(normalizeViewerChatSwitchesPatch({ chat: true, bogus: true }), { chat: true });
    assert.equal(normalizeViewerChatSwitchesPatch({ chat: 'true' }), null);
    assert.equal(normalizeViewerChatSwitchesPatch(null), null);
    assert.equal(normalizeViewerChatSwitchesPatch([true]), null);
  });

  it('knows a valid viewer id and a reaction', () => {
    assert.equal(isValidViewerId('abcdefghijklmnop'), true);
    assert.equal(isValidViewerId('short'), false);
    assert.equal(isValidViewerId('has space in it!!!'), false);
    assert.equal(isValidViewerId(5), false);
    assert.equal(isViewerReactionType('love'), true);
    assert.equal(isViewerReactionType('laugh'), false);
    assert.equal(isViewerReactionType('<script>'), false);
  });
});

describe('how often a page asks', () => {
  it('suggests slower asking as the room gets busier', () => {
    assert.equal(suggestViewerPollMs(0), 4000);
    assert.equal(suggestViewerPollMs(40), 4000);
    assert.equal(suggestViewerPollMs(80), 6000);
    assert.equal(suggestViewerPollMs(200), 10_000);
    assert.equal(suggestViewerPollMs(900), 15_000);
    assert.equal(suggestViewerPollMs(Number.NaN), 4000);
  });

  it('asks much less often while the tab is hidden', () => {
    assert.equal(effectiveViewerPollMs(4000, false), 4000);
    assert.equal(effectiveViewerPollMs(4000, true), 15_000);
    assert.equal(effectiveViewerPollMs(10_000, true), 30_000);
    assert.equal(effectiveViewerPollMs(undefined, false), 4000);
    assert.equal(effectiveViewerPollMs(1, false), 2000, 'a hint is kept within sensible bounds');
    assert.equal(effectiveViewerPollMs(10 ** 9, false), 30_000);
  });

  it('measures the request rate over a window', () => {
    const meter = createRequestRateMeter(0);
    let rate = 0;
    for (let i = 0; i < 100; i += 1) rate = noteRequest(meter, i * 50);
    assert.equal(rate, 0, 'nothing is reported before a full window');
    rate = noteRequest(meter, 10_000);
    assert.ok(rate > 9 && rate < 11, `about 10 a second, got ${rate}`);
  });
});
