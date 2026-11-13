import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TEST_VERDICT_AFTER_MS,
  evaluateTestStream,
  type TestStreamMeasurements,
} from '../src/utils/testStreamVerdict.ts';

function good(overrides: {
  elapsedMs?: number;
  connected?: boolean;
  reconnectAttempts?: number;
  relayLatencyMs?: number | null;
  video?: Partial<TestStreamMeasurements['video']>;
  audio?: Partial<TestStreamMeasurements['audio']>;
  drops?: Partial<TestStreamMeasurements['drops']>;
} = {}): TestStreamMeasurements {
  return {
    elapsedMs: overrides.elapsedMs ?? 18_000,
    connected: overrides.connected ?? true,
    reconnectAttempts: overrides.reconnectAttempts ?? 0,
    relayLatencyMs: overrides.relayLatencyMs === undefined ? 120 : overrides.relayLatencyMs,
    video: { width: 1280, height: 720, targetFps: 30, encoderFps: 30, uploadKbps: 2400, lastChunkAgoMs: 400, ...overrides.video },
    audio: { peakDb: -12, ...overrides.audio },
    drops: { droppedFrames: 0, backlogSeconds: 0, serverDroppedFrames: 0, serverSpeed: 1.4, ...overrides.drops },
  };
}

function check(verdict: ReturnType<typeof evaluateTestStream>, id: string) {
  const found = verdict.checks.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

describe('test stream verdict', () => {
  it('says ready when picture, sound, frames and connection are fine', () => {
    const verdict = evaluateTestStream(good());
    assert.equal(verdict.kind, 'ready');
    assert.equal(verdict.headline, 'Ready to go live');
    assert.ok(verdict.checks.every((item) => item.status === 'ok'));
  });

  it('waits for the settle time before judging, then gives one verdict', () => {
    const early = evaluateTestStream(good({ elapsedMs: TEST_VERDICT_AFTER_MS - 1_000, audio: { peakDb: -90 } }));
    assert.equal(early.kind, 'checking');
    const settled = evaluateTestStream(good({ elapsedMs: TEST_VERDICT_AFTER_MS, audio: { peakDb: -90 } }));
    assert.equal(settled.kind, 'problem');
  });

  it('names silence and what to do about it', () => {
    const verdict = evaluateTestStream(good({ audio: { peakDb: -80 } }));
    assert.equal(verdict.kind, 'problem');
    assert.match(verdict.headline, /sound present/i);
    assert.match(verdict.detail, /silent/i);
    assert.match(verdict.detail, /Unmute/);
    assert.equal(check(verdict, 'sound').status, 'fail');
  });

  it('treats very quiet or clipping sound as a note, not a failure', () => {
    const quiet = evaluateTestStream(good({ audio: { peakDb: -45 } }));
    assert.equal(quiet.kind, 'ready');
    assert.equal(check(quiet, 'sound').status, 'warn');
    assert.match(quiet.detail, /quiet/);
    const loud = evaluateTestStream(good({ audio: { peakDb: 0 } }));
    assert.equal(check(loud, 'sound').status, 'warn');
  });

  it('fails when the picture stopped or hardly any data arrives', () => {
    const stalled = evaluateTestStream(good({ video: { lastChunkAgoMs: 9_000 } }));
    assert.equal(stalled.kind, 'problem');
    assert.match(stalled.detail, /stopped arriving/);
    const starved = evaluateTestStream(good({ video: { uploadKbps: 20 } }));
    assert.equal(check(starved, 'video').status, 'fail');
    const none = evaluateTestStream(good({ video: { lastChunkAgoMs: null } }));
    assert.equal(check(none, 'video').status, 'fail');
  });

  it('warns about a very low bitrate and shows the resolution', () => {
    const verdict = evaluateTestStream(good({ video: { uploadKbps: 120 } }));
    assert.equal(check(verdict, 'video').status, 'warn');
    assert.match(check(verdict, 'video').detail, /1280x720/);
    assert.equal(verdict.kind, 'ready');
  });

  it('judges the frame rate against the target', () => {
    assert.equal(check(evaluateTestStream(good({ video: { encoderFps: 26 } })), 'framerate').status, 'ok');
    assert.equal(check(evaluateTestStream(good({ video: { encoderFps: 22 } })), 'framerate').status, 'warn');
    assert.equal(check(evaluateTestStream(good({ video: { encoderFps: 12 } })), 'framerate').status, 'fail');
    // Not reported yet: still measuring, so no verdict of ready.
    const unknown = evaluateTestStream(good({ video: { encoderFps: null } }));
    assert.equal(check(unknown, 'framerate').status, 'pending');
    assert.equal(unknown.kind, 'checking');
  });

  it('flags lost frames and a growing backlog', () => {
    // 18 s at 30 fps is 540 frames: 20 lost is 3.7%.
    const some = evaluateTestStream(good({ drops: { droppedFrames: 20 } }));
    assert.equal(check(some, 'drops').status, 'warn');
    const many = evaluateTestStream(good({ drops: { droppedFrames: 60, serverDroppedFrames: 10 } }));
    assert.equal(check(many, 'drops').status, 'fail');
    const backlog = evaluateTestStream(good({ drops: { backlogSeconds: 6 } }));
    assert.equal(backlog.kind, 'problem');
    assert.match(backlog.detail, /waiting to be sent/);
    assert.match(backlog.detail, /upload/);
    const slowServer = evaluateTestStream(good({ drops: { serverSpeed: 0.7 } }));
    assert.equal(check(slowServer, 'drops').status, 'fail');
    assert.match(check(slowServer, 'drops').detail, /media server cannot keep up/);
  });

  it('fails an unstable connection at once, even before the settle time', () => {
    const lost = evaluateTestStream(good({ elapsedMs: 3_000, connected: false }));
    assert.equal(lost.kind, 'problem');
    assert.match(lost.headline, /connection/i);
    const dropped = evaluateTestStream(good({ reconnectAttempts: 2 }));
    assert.equal(check(dropped, 'connection').status, 'fail');
    assert.match(check(dropped, 'connection').detail, /2 times/);
    const slow = evaluateTestStream(good({ relayLatencyMs: 2_400 }));
    assert.equal(check(slow, 'connection').status, 'warn');
    assert.equal(slow.kind, 'ready');
  });

  it('reports the most serious problem first', () => {
    const verdict = evaluateTestStream(good({ audio: { peakDb: -90 }, connected: false, reconnectAttempts: 1 }));
    assert.match(verdict.headline, /connection/i);
    assert.equal(verdict.checks.filter((item) => item.status === 'fail').length, 2);
  });
});
