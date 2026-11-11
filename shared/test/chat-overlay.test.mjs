import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHAT_OVERLAY_MAX_IDS,
  applyChatOverlayPatch,
  chatOverlayStateToPatch,
  isDefaultChatOverlayState,
  CHAT_OVERLAY_PENDING_TTL_MS,
  chatOverlayStatesEqual,
  decideChatOverlayOnJoin,
  loadSavedChatOverlayState,
  normalizeChatOverlaySeq,
  reconcileChatOverlay,
  defaultChatOverlayState,
  normalizeChatOverlayPatch,
  normalizeChatOverlayState,
} from '../dist/index.js';

describe('chat overlay state', () => {
  it('starts off, medium, regular, left and in all mode', () => {
    assert.deepEqual(defaultChatOverlayState(), {
      enabled: false, size: 'm', layout: 'regular', side: 'left', mode: 'all',
      paused: false, pausedIds: [], hiddenIds: [], shownIds: [],
    });
  });

  it('normalizes junk to safe defaults and bounds every list', () => {
    const state = normalizeChatOverlayState({
      enabled: 'yes', size: 'xl', layout: 7, side: 'up', mode: 'everything',
      hiddenIds: ['a', 'a', '', 5, 'x'.repeat(500), 'b'],
      shownIds: Array.from({ length: CHAT_OVERLAY_MAX_IDS + 20 }, (_, i) => `id${i}`),
      pausedIds: ['p'],
    });
    assert.equal(state.enabled, false);
    assert.equal(state.size, 'm');
    assert.equal(state.layout, 'regular');
    assert.equal(state.side, 'left');
    assert.equal(state.mode, 'all');
    assert.deepEqual(state.hiddenIds, ['a', 'b']);
    assert.equal(state.shownIds.length, CHAT_OVERLAY_MAX_IDS);
    assert.equal(state.shownIds.at(-1), `id${CHAT_OVERLAY_MAX_IDS + 19}`, 'newest kept');
    assert.deepEqual(state.pausedIds, [], 'paused ids only count while paused');
    assert.deepEqual(normalizeChatOverlayState(null), defaultChatOverlayState());
  });
});

describe('chat overlay patch', () => {
  it('drops unknown keys and invalid values, and returns null for nothing usable', () => {
    assert.equal(normalizeChatOverlayPatch(null), null);
    assert.equal(normalizeChatOverlayPatch([]), null);
    assert.equal(normalizeChatOverlayPatch({ size: 'huge', evil: true }), null);
    assert.deepEqual(normalizeChatOverlayPatch({ size: 'l', evil: true, hide: ['a', 3] }), { size: 'l', hide: ['a'] });
  });

  it('applies settings, hide/unhide and shown ids without losing other operators updates', () => {
    let state = defaultChatOverlayState();
    state = applyChatOverlayPatch(state, { enabled: true, layout: 'wide', side: 'right', mode: 'approved' });
    assert.deepEqual([state.enabled, state.layout, state.side, state.mode], [true, 'wide', 'right', 'approved']);
    state = applyChatOverlayPatch(state, { hide: ['c1'] });
    state = applyChatOverlayPatch(state, { hide: ['c2'], show: ['c9'] });
    assert.deepEqual(state.hiddenIds, ['c1', 'c2']);
    state = applyChatOverlayPatch(state, { unhide: ['c1'] });
    assert.deepEqual(state.hiddenIds, ['c2']);
    assert.deepEqual(state.shownIds, ['c9']);
    state = applyChatOverlayPatch(state, { clearHidden: true });
    assert.deepEqual(state.hiddenIds, []);
  });

  it('pause freezes the supplied ids and resume clears them', () => {
    let state = applyChatOverlayPatch(defaultChatOverlayState(), { paused: true, pausedIds: ['a', 'b'] });
    assert.deepEqual([state.paused, state.pausedIds], [true, ['a', 'b']]);
    state = applyChatOverlayPatch(state, { paused: false });
    assert.deepEqual([state.paused, state.pausedIds], [false, []]);
  });
});

describe('republishing the browser copy', () => {
  const custom = applyChatOverlayPatch(defaultChatOverlayState(), { enabled: true, size: 'l', side: 'right', hide: ['h1'], show: ['s1'], paused: true, pausedIds: ['p1'] });

  it('rebuilds the same state on a server that lost it', () => {
    const rebuilt = applyChatOverlayPatch(defaultChatOverlayState(), chatOverlayStateToPatch(custom));
    assert.deepEqual(rebuilt, custom);
    assert.equal(isDefaultChatOverlayState(defaultChatOverlayState()), true);
    assert.equal(isDefaultChatOverlayState(custom), false);
  });

  it('drops a saved pause when loading the browser copy', () => {
    const loaded = loadSavedChatOverlayState(JSON.parse(JSON.stringify(custom)));
    assert.equal(loaded.paused, false);
    assert.deepEqual(loaded.pausedIds, []);
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.size, 'l');
    assert.deepEqual(loaded.hiddenIds, ['h1']);
    assert.deepEqual(loadSavedChatOverlayState('junk'), defaultChatOverlayState());
  });
});

describe('what a browser does with its own copy right after joining', () => {
  const copy = loadSavedChatOverlayState({ enabled: true, size: 'l', mode: 'approved', hiddenIds: ['h1'] });
  const base = { isHost: true, serverSupported: true, serverHasState: false, local: copy };

  it('the host publishes a copy that is not the defaults', () => {
    assert.equal(decideChatOverlayOnJoin(base), 'publish');
  });

  it('the host with the default copy has nothing to publish', () => {
    assert.equal(decideChatOverlayOnJoin({ ...base, local: defaultChatOverlayState() }), 'keep');
  });

  it('a co-host never publishes and shows the defaults', () => {
    assert.equal(decideChatOverlayOnJoin({ ...base, isHost: false }), 'reset');
    assert.equal(decideChatOverlayOnJoin({ ...base, isHost: false, local: defaultChatOverlayState() }), 'reset');
  });

  it('keeps the server state when the server sent one', () => {
    assert.equal(decideChatOverlayOnJoin({ ...base, serverHasState: true }), 'keep');
    assert.equal(decideChatOverlayOnJoin({ ...base, serverHasState: true, isHost: false }), 'keep');
  });

  it('a server without the feature keeps everything local and never sends', () => {
    assert.equal(decideChatOverlayOnJoin({ ...base, serverSupported: false }), 'keep');
    assert.equal(decideChatOverlayOnJoin({ ...base, serverSupported: false, isHost: false }), 'keep');
  });
});

describe('answers from the server and changes not yet answered', () => {
  const t0 = 1_000_000;
  const hideA = { seq: 1, patch: { hide: ['A'] }, sentAt: t0 };
  const hideB = { seq: 2, patch: { hide: ['B'] }, sentAt: t0 + 200 };

  it('accepts only a non-negative safe integer as a change number', () => {
    assert.equal(normalizeChatOverlaySeq(0), 0);
    assert.equal(normalizeChatOverlaySeq(7), 7);
    for (const bad of [-1, 1.5, '3', null, undefined, NaN, Infinity, 2 ** 53, {}, []]) assert.equal(normalizeChatOverlaySeq(bad), undefined);
  });

  it('keeps comment B hidden when the answer to hiding A arrives first', () => {
    const serverAfterA = applyChatOverlayPatch(defaultChatOverlayState(), { hide: ['A'] });
    const result = reconcileChatOverlay({ server: serverAfterA, ack: 1, pending: [hideA, hideB], now: t0 + 250 });
    assert.deepEqual(result.state.hiddenIds, ['A', 'B']);
    assert.deepEqual(result.pending, [hideB]);
    const serverAfterB = applyChatOverlayPatch(serverAfterA, { hide: ['B'] });
    const done = reconcileChatOverlay({ server: serverAfterB, ack: 2, pending: result.pending, now: t0 + 400 });
    assert.deepEqual(done.state.hiddenIds, ['A', 'B']);
    assert.deepEqual(done.pending, []);
  });

  it('lays our pending change on top of another operator update that has no ack', () => {
    const theirs = applyChatOverlayPatch(defaultChatOverlayState(), { mode: 'approved', hide: ['X'] });
    const result = reconcileChatOverlay({ server: theirs, pending: [hideA], now: t0 + 100 });
    assert.equal(result.state.mode, 'approved');
    assert.deepEqual(result.state.hiddenIds, ['X', 'A']);
    assert.deepEqual(result.pending, [hideA]);
  });

  it('an answer for change 2 clears changes 1 and 2', () => {
    const server = applyChatOverlayPatch(defaultChatOverlayState(), { hide: ['A', 'B'] });
    const result = reconcileChatOverlay({ server, ack: 2, pending: [hideA, hideB], now: t0 + 300 });
    assert.deepEqual(result.pending, []);
    assert.equal(result.state, server, 'nothing pending: the server state itself');
  });

  it('gives up an unanswered change after 3 seconds', () => {
    const server = defaultChatOverlayState();
    const early = reconcileChatOverlay({ server, pending: [hideA], now: t0 + CHAT_OVERLAY_PENDING_TTL_MS - 1 });
    assert.deepEqual(early.state.hiddenIds, ['A']);
    const late = reconcileChatOverlay({ server, pending: [hideA, hideB], now: t0 + CHAT_OVERLAY_PENDING_TTL_MS + 1 });
    assert.deepEqual(late.state.hiddenIds, ['B'], 'A expired, B (sent 200 ms later) has not yet');
    assert.deepEqual(late.pending, [hideB]);
  });

  it('works against a server that never answers with an ack', () => {
    const server = applyChatOverlayPatch(defaultChatOverlayState(), { hide: ['A'] });
    const result = reconcileChatOverlay({ server, pending: [hideA], now: t0 + 50 });
    assert.deepEqual(result.state.hiddenIds, ['A']);
    const later = reconcileChatOverlay({ server, pending: result.pending, now: t0 + 5000 });
    assert.deepEqual(later.pending, []);
    assert.deepEqual(later.state.hiddenIds, ['A']);
  });

  it('ignores a bad ack', () => {
    const result = reconcileChatOverlay({ server: defaultChatOverlayState(), ack: -3, pending: [hideA], now: t0 });
    assert.deepEqual(result.pending, [hideA]);
  });

  it('compares states by value', () => {
    const a = applyChatOverlayPatch(defaultChatOverlayState(), { hide: ['A'], size: 'l' });
    const b = applyChatOverlayPatch(defaultChatOverlayState(), { hide: ['A'], size: 'l' });
    assert.equal(chatOverlayStatesEqual(a, b), true);
    assert.equal(chatOverlayStatesEqual(a, { ...b, hiddenIds: ['B'] }), false);
    assert.equal(chatOverlayStatesEqual(a, { ...b, paused: true }), false);
  });
});
