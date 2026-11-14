import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeldBroadcastAnswer, type HeldBroadcastCandidate } from './heldBroadcast.js';

const NOW = 1_000_000;
const HOLD = 180_000;

function candidate(overrides: Partial<HeldBroadcastCandidate> = {}): HeldBroadcastCandidate {
  return {
    clientGone: true,
    started: true,
    stopping: false,
    test: false,
    claims: { roomId: 'room-1' },
    slate: { startedAtMs: NOW - 30_000 },
    destinations: [{ id: 'd1', name: 'YouTube' }, { id: 'd2', name: 'Facebook' }],
    relays: new Map([
      ['d1', { live: true, exited: false }],
      ['d2', { live: false, exited: true }],
    ]),
    confirmedDestinations: new Set(['d1', 'd2']),
    ...overrides,
  };
}

const ask = (sessions: HeldBroadcastCandidate[], roomId = 'room-1', nowMs = NOW) =>
  buildHeldBroadcastAnswer({ roomId, sessions, nowMs, holdMs: HOLD });

describe('buildHeldBroadcastAnswer', () => {
  it('reports a held broadcast with the seconds left and each destination name and connection', () => {
    assert.deepEqual(ask([candidate()]), {
      held: true,
      state: 'held',
      secondsLeft: 150,
      destinations: [
        { name: 'YouTube', connected: true },
        { name: 'Facebook', connected: false },
      ],
    });
  });

  it('rounds the seconds up and never reports more than the whole hold', () => {
    assert.equal(ask([candidate({ slate: { startedAtMs: NOW - 29_500 } })]).secondsLeft, 151);
    assert.equal(ask([candidate({ slate: { startedAtMs: NOW + 5_000 } })]).secondsLeft, 180);
    assert.equal(ask([candidate({ slate: null })]).secondsLeft, 180);
  });

  it('says nothing is held once the hold has run out', () => {
    assert.deepEqual(ask([candidate({ slate: { startedAtMs: NOW - HOLD } })]), { held: false, state: 'none' });
  });

  it('answers false for another room, and for no sessions at all', () => {
    assert.deepEqual(ask([candidate()], 'room-2'), { held: false, state: 'none' });
    assert.deepEqual(ask([]), { held: false, state: 'none' });
  });

  it('says a running broadcast is running, not held', () => {
    assert.deepEqual(ask([candidate({ clientGone: false })]), { held: false, state: 'broadcast' });
  });

  it('says a private test is a test, not held', () => {
    assert.deepEqual(ask([candidate({ clientGone: false, test: true })]), { held: false, state: 'test' });
    assert.deepEqual(ask([candidate({ test: true })]), { held: false, state: 'test' });
  });

  it('ignores sessions that are not started or are stopping', () => {
    assert.deepEqual(ask([candidate({ started: false })]), { held: false, state: 'none' });
    assert.deepEqual(ask([candidate({ stopping: true })]), { held: false, state: 'none' });
  });

  it('prefers the held broadcast when the room also has a test', () => {
    const answer = ask([candidate({ clientGone: false, test: true }), candidate()]);
    assert.equal(answer.held, true);
  });

  it('treats a destination that never held a connection as not connected', () => {
    const answer = ask([candidate({ confirmedDestinations: new Set(['d2']) })]);
    assert.deepEqual(answer.destinations?.map((d) => d.connected), [false, false]);
  });

  it('shortens and cleans display names', () => {
    const answer = ask([candidate({ destinations: [{ id: 'd1', name: `  My\n  church ${'x'.repeat(200)}` }] })]);
    const name = answer.destinations?.[0].name ?? '';
    assert.ok(name.startsWith('My church x'));
    assert.ok(name.length <= 80);
  });

  it('carries no key, URL or id of any destination', () => {
    const secretive = candidate({
      destinations: [{ id: 'd1', name: 'YouTube' }],
    });
    (secretive.destinations[0] as Record<string, unknown>).streamKey = 'SECRET-KEY';
    (secretive.destinations[0] as Record<string, unknown>).rtmpUrl = 'rtmp://secret.example/live';
    const text = JSON.stringify(ask([secretive]));
    assert.doesNotMatch(text, /SECRET-KEY|rtmp:|secret\.example|"id"|d1/);
  });
});
