import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RtmpRelayStartPayload } from '@studio/shared';
import { isSameRelaySetup } from './relayResume.js';
import { isServableHlsFile, isValidWatchRoomId } from './hlsOutput.js';
import { createTestWatchId, getCapacityRefusal, getTestStartIssue, isTestWatchId, mayStartDestination } from './testStream.js';

const destination = { id: 'd1', name: 'YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'key-1' };

function payload(overrides: Partial<RtmpRelayStartPayload> = {}): RtmpRelayStartPayload {
  return {
    token: 't',
    destinations: [],
    video: { width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 2_500_000 },
    audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 128_000 },
    ...overrides,
  };
}

describe('test stream start', () => {
  it('accepts a test with no destinations', () => {
    assert.equal(getTestStartIssue(payload({ test: true }), true), null);
  });

  it('refuses a test that carries any destination, at start and on a reconnect start', () => {
    assert.match(getTestStartIssue(payload({ test: true, destinations: [destination] }), true) || '', /never sends to a destination/);
    // A reconnect is a new start message; the same rule applies.
    assert.match(getTestStartIssue(payload({ test: true, destinations: [destination, { ...destination, id: 'd2' }] }), true) || '', /never sends/);
  });

  it('refuses a test when the shared encode is off', () => {
    assert.match(getTestStartIssue(payload({ test: true }), false) || '', /shared encode/);
  });

  it('leaves real broadcasts to the normal checks', () => {
    assert.equal(getTestStartIssue(payload({ destinations: [destination] }), true), null);
    assert.equal(getTestStartIssue(payload({ destinations: [destination], test: false }), false), null);
  });

  it('never lets a test session start a destination', () => {
    assert.equal(mayStartDestination({ test: true }), false);
    assert.equal(mayStartDestination({ test: false }), true);
  });

  it('never resumes a test as a broadcast, or a broadcast as a test', () => {
    assert.equal(isSameRelaySetup(payload({ test: true }), payload({ test: true })), true);
    assert.equal(isSameRelaySetup(payload({ test: true }), payload({ destinations: [destination] })), false);
    assert.equal(isSameRelaySetup(payload({ destinations: [destination] }), payload({ test: true })), false);
  });
});

describe('test output address', () => {
  it('is unguessable, unique and separate from any studio watch id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createTestWatchId()));
    assert.equal(ids.size, 50);
    for (const id of ids) {
      assert.ok(isTestWatchId(id));
      assert.ok(isValidWatchRoomId(id), 'fits the watch id pattern');
      assert.ok(id.length >= 20, 'at least 120 bits');
      // The HLS writer folder and segment names built from it must still be servable.
      assert.ok(isServableHlsFile(`seg-${id}-abcdef-00001.ts`));
    }
    assert.equal(isTestWatchId('studio-watch-id'), false);
  });
});

describe('capacity refusal', () => {
  it('says what is running and what to do', () => {
    assert.match(getCapacityRefusal({ incomingIsTest: false, runningIsTest: true }).message, /End the test before going live/);
    assert.match(getCapacityRefusal({ incomingIsTest: true, runningIsTest: false }).message, /cannot run at the same time/);
    assert.match(getCapacityRefusal({ incomingIsTest: true, runningIsTest: true }).message, /already running/);
    assert.match(getCapacityRefusal({ incomingIsTest: false, runningIsTest: false }).message, /another broadcast/);
  });
});
