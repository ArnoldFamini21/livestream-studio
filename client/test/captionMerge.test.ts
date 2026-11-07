import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAPTION_ACTIVE_MS,
  EMPTY_REMOTE_CAPTIONS,
  anchorRemoteCaptionTiming,
  applyRemoteCaption,
  createCaptionSendThrottle,
  mergeCaptionSegments,
  pruneRemoteInterims,
  selectBroadcastCaption,
} from '../src/utils/captionMerge.ts';
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
