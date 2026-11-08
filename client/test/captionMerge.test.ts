import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAPTION_ACTIVE_MS,
  EMPTY_REMOTE_CAPTIONS,
  anchorRemoteCaptionTiming,
  applyRemoteCaption,
  createCaptionSendThrottle,
  getNextCaptionExpiryDelayMs,
  mergeCaptionSegments,
  pruneRemoteInterims,
  selectBroadcastCaption,
} from '../src/utils/captionMerge.ts';
import {
  CAPTION_SHARE_STORAGE_PREFIX,
  LEGACY_CAPTION_SHARE_STORAGE_KEY,
  pickAuthoritativeCaptionsState,
  readCaptionShareChoice,
  writeCaptionShareChoice,
} from '../src/utils/captionShareConsent.ts';
import type { LiveCaptionSegment } from '../src/hooks/useLiveCaptions.ts';

const HOST_NOW = Date.parse('2026-11-08T12:00:00.000Z');
// The guest's laptop clock runs 9 s behind the host's.
const GUEST_CLOCK = HOST_NOW - 9000;

function remote(segmentId: string, text: string, final: boolean, durationMs = 2000) {
  return { participantId: 'guest-1', speakerName: 'Maria', segmentId, text, startMs: GUEST_CLOCK - durationMs, endMs: GUEST_CLOCK, final };
}

function local(text: string, atMs: number, interim = false): LiveCaptionSegment {
  return { id: `local-${atMs}`, speakerName: 'Arnold', text, interim, timestamp: new Date(atMs).toISOString() };
}

describe('caption merge', () => {
  it('keeps a remote duration but anchors it to the host clock', () => {
    assert.deepEqual(anchorRemoteCaptionTiming({ startMs: GUEST_CLOCK - 2500, endMs: GUEST_CLOCK }, HOST_NOW), { startMs: HOST_NOW - 2500, endMs: HOST_NOW });
    assert.deepEqual(anchorRemoteCaptionTiming({ startMs: 0, endMs: 1e9 }, HOST_NOW), { startMs: HOST_NOW - 30_000, endMs: HOST_NOW });
  });

  it('replaces interim updates per speaker and moves the final into the transcript', () => {
    let state = applyRemoteCaption(EMPTY_REMOTE_CAPTIONS, remote('u1', 'Hello', false), HOST_NOW);
    state = applyRemoteCaption(state, remote('u1', 'Hello from', false), HOST_NOW + 400);
    assert.equal(state.finals.length, 0);
    assert.equal(state.interims['guest-1'].segment.text, 'Hello from');
    state = applyRemoteCaption(state, remote('u1', 'Hello from Ohio.', true), HOST_NOW + 900);
    assert.deepEqual(Object.keys(state.interims), []);
    assert.equal(state.finals.length, 1);
    assert.equal(state.finals[0].speakerName, 'Maria');
    assert.equal(state.finals[0].participantId, 'guest-1');
    assert.equal(state.finals[0].timestamp, new Date(HOST_NOW + 900).toISOString());
    // A repeated final for the same utterance replaces rather than duplicates.
    state = applyRemoteCaption(state, remote('u1', 'Hello from Ohio!', true), HOST_NOW + 950);
    assert.equal(state.finals.length, 1);
    assert.equal(state.finals[0].text, 'Hello from Ohio!');
  });

  it('orders host and guest lines on one timeline with speaker labels', () => {
    let state = applyRemoteCaption(EMPTY_REMOTE_CAPTIONS, remote('u1', 'Thanks for having me.', true), HOST_NOW + 3000);
    state = applyRemoteCaption(state, remote('u2', 'It was a long flight.', true), HOST_NOW + 9000);
    const merged = mergeCaptionSegments([local('Welcome to the show.', HOST_NOW), local('How was the trip?', HOST_NOW + 6000)], state.finals);
    assert.deepEqual(merged.map((segment) => `${segment.speakerName}: ${segment.text}`), [
      'Arnold: Welcome to the show.',
      'Maria: Thanks for having me.',
      'Arnold: How was the trip?',
      'Maria: It was a long flight.',
    ]);
    assert.equal(mergeCaptionSegments(merged, []), merged);
  });

  it('shows whoever spoke last on the broadcast, then nothing once it is stale', () => {
    let state = applyRemoteCaption(EMPTY_REMOTE_CAPTIONS, remote('u1', 'I think', false), HOST_NOW + 1000);
    const hostFinal = local('Great question.', HOST_NOW);
    assert.equal(selectBroadcastCaption(hostFinal, state, HOST_NOW + 1200)?.speakerName, 'Maria');
    assert.equal(selectBroadcastCaption(local('So', HOST_NOW + 1500, true), state, HOST_NOW + 1500)?.speakerName, 'Arnold');
    state = pruneRemoteInterims(state, HOST_NOW + 1000 + CAPTION_ACTIVE_MS + 1);
    assert.deepEqual(state.interims, {});
    assert.equal(selectBroadcastCaption(null, state, HOST_NOW + 60_000), null);
  });

  it('throttles interim sends per utterance but never finals', () => {
    const allow = createCaptionSendThrottle(800);
    assert.equal(allow('a', false, 0), true);
    assert.equal(allow('a', false, 300), false);
    assert.equal(allow('a', false, 900), true);
    assert.equal(allow('a', true, 950), true);
    assert.equal(allow('b', false, 960), true);
  });
});

describe('caption clock', () => {
  it('stops ticking once the newest remote line is older than the active window', () => {
    const state = applyRemoteCaption(EMPTY_REMOTE_CAPTIONS, remote('u1', 'Hello.', true), HOST_NOW);
    assert.equal(getNextCaptionExpiryDelayMs(state, HOST_NOW + 1000), CAPTION_ACTIVE_MS - 1000);
    assert.equal(getNextCaptionExpiryDelayMs(state, HOST_NOW + CAPTION_ACTIVE_MS), null);
    assert.equal(getNextCaptionExpiryDelayMs(state, HOST_NOW + 60_000), null, 'a session full of old finals runs no timer');
    assert.equal(getNextCaptionExpiryDelayMs(EMPTY_REMOTE_CAPTIONS, HOST_NOW), null);
  });

  it('wakes when an interim goes stale so it can be pruned', () => {
    const state = applyRemoteCaption(EMPTY_REMOTE_CAPTIONS, remote('u2', 'Hel', false), HOST_NOW);
    const delay = getNextCaptionExpiryDelayMs(state, HOST_NOW);
    assert.equal(delay, CAPTION_ACTIVE_MS + 1);
    const later = HOST_NOW + (delay ?? 0);
    const pruned = pruneRemoteInterims(state, later);
    assert.deepEqual(Object.keys(pruned.interims), []);
    assert.equal(getNextCaptionExpiryDelayMs(pruned, later), null);
    assert.equal(getNextCaptionExpiryDelayMs(state, HOST_NOW + 60_000), 0, 'an overdue interim is pruned right away');
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('caption share consent', () => {
  it('is kept for one studio only and starts off in every other', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    assert.equal(readCaptionShareChoice('room-a', session, local), false);
    writeCaptionShareChoice('room-a', true, session);
    assert.equal(readCaptionShareChoice('room-a', session, local), true);
    assert.equal(readCaptionShareChoice('room-b', session, local), false);
    assert.equal(readCaptionShareChoice(null, session, local), false);
    writeCaptionShareChoice('room-a', false, session);
    assert.equal(session.values.has(CAPTION_SHARE_STORAGE_PREFIX + 'room-a'), false);
  });

  it('drops the old global yes instead of reusing it', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    local.setItem(LEGACY_CAPTION_SHARE_STORAGE_KEY, '1');
    assert.equal(readCaptionShareChoice('room-a', session, local), false);
    assert.equal(local.values.has(LEGACY_CAPTION_SHARE_STORAGE_KEY), false);
  });

  it('survives blocked storage', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    assert.equal(readCaptionShareChoice('room-a', throwing, throwing), false);
    assert.doesNotThrow(() => writeCaptionShareChoice('room-a', true, throwing));
  });
});

describe('authoritative captions state', () => {
  it('follows the stage owner, so a co-host sending enabled:false after the host sent enabled:true changes nothing', () => {
    const states = {
      host: { enabled: true, language: 'en-US', from: 'host' },
      cohost: { enabled: false, language: 'en-US', from: 'cohost' },
    };
    assert.equal(pickAuthoritativeCaptionsState(states, 'host')?.enabled, true);
    assert.equal(pickAuthoritativeCaptionsState(states, 'cohost')?.enabled, false, 'the co-host speaks only once it owns the stage');
    assert.equal(pickAuthoritativeCaptionsState(states, null), null);
    assert.equal(pickAuthoritativeCaptionsState({ cohost: states.cohost }, 'host'), null);
  });
});
