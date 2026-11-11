import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHAT_OVERLAY_MAX_IDS,
  applyChatOverlayPatch,
  chatOverlayStateToPatch,
  isDefaultChatOverlayState,
  shouldPublishLocalChatOverlay,
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
  const ready = { canControl: true, connected: true, serverSupported: true, serverHasState: false, state: custom };

  it('rebuilds the same state on a server that lost it', () => {
    const rebuilt = applyChatOverlayPatch(defaultChatOverlayState(), chatOverlayStateToPatch(custom));
    assert.deepEqual(rebuilt, custom);
    assert.equal(isDefaultChatOverlayState(defaultChatOverlayState()), true);
    assert.equal(isDefaultChatOverlayState(custom), false);
  });

  it('publishes only for an operator, on a server that advertises the feature and holds nothing', () => {
    assert.equal(shouldPublishLocalChatOverlay(ready), true);
    assert.equal(shouldPublishLocalChatOverlay({ ...ready, canControl: false }), false, 'guests never publish');
    assert.equal(shouldPublishLocalChatOverlay({ ...ready, serverSupported: false }), false, 'old server: stay local');
    assert.equal(shouldPublishLocalChatOverlay({ ...ready, serverHasState: true }), false, 'the server copy wins');
    assert.equal(shouldPublishLocalChatOverlay({ ...ready, connected: false }), false);
    assert.equal(shouldPublishLocalChatOverlay({ ...ready, state: defaultChatOverlayState() }), false, 'nothing to publish');
  });
});
