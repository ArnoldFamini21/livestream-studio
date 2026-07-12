import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signLiveStreamToken } from './auth.js';
import { parseSfuAuthFrame, verifySfuIdentity } from './sfuAuth.js';

const SECRET = 'test-secret-that-is-at-least-32-chars!!';
const NOW = 1_700_000_000_000;

function hostToken(overrides: Record<string, unknown> = {}): string {
  return signLiveStreamToken({
    v: 1,
    roomId: 'room-1',
    participantId: 'host-1',
    role: 'host',
    exp: NOW + 60_000,
    nonce: 'n1',
    ...overrides,
  } as never, SECRET);
}

function guestToken(overrides: Record<string, unknown> = {}): string {
  return signLiveStreamToken({
    v: 1,
    purpose: 'recording-upload',
    roomId: 'room-1',
    participantId: 'guest-7',
    participantName: 'Guest Seven',
    role: 'guest',
    sessionId: 'session-1',
    exp: NOW + 60_000,
    nonce: 'n2',
    ...overrides,
  } as never, SECRET);
}

function sfuToken(overrides: Record<string, unknown> = {}): string {
  return signLiveStreamToken({
    v: 1,
    purpose: 'sfu',
    roomId: 'room-1',
    participantId: 'guest-7',
    role: 'guest',
    exp: NOW + 60_000,
    nonce: 'sfu-nonce',
    ...overrides,
  } as never, SECRET);
}

describe('parseSfuAuthFrame', () => {
  it('accepts a well-formed auth frame', () => {
    assert.deepEqual(parseSfuAuthFrame({ type: 'sfu-auth', token: 'abc' }), { token: 'abc' });
  });

  it('rejects wrong types, missing tokens, and oversized tokens', () => {
    assert.equal(parseSfuAuthFrame(null), null);
    assert.equal(parseSfuAuthFrame({ type: 'sfu-join' }), null);
    assert.equal(parseSfuAuthFrame({ type: 'sfu-auth' }), null);
    assert.equal(parseSfuAuthFrame({ type: 'sfu-auth', token: '' }), null);
    assert.equal(parseSfuAuthFrame({ type: 'sfu-auth', token: 'x'.repeat(5000) }), null);
    assert.equal(parseSfuAuthFrame(['sfu-auth']), null);
  });
});

describe('verifySfuIdentity', () => {
  it('accepts a purpose-scoped token for an admitted guest outside recording', () => {
    assert.deepEqual(verifySfuIdentity(sfuToken(), SECRET, NOW), {
      roomId: 'room-1',
      participantId: 'guest-7',
      role: 'guest',
    });
  });

  it('accepts a host live-stream token', () => {
    assert.deepEqual(verifySfuIdentity(hostToken(), SECRET, NOW), {
      roomId: 'room-1',
      participantId: 'host-1',
      role: 'host',
    });
  });

  it('accepts a guest recording-upload token', () => {
    assert.deepEqual(verifySfuIdentity(guestToken(), SECRET, NOW), {
      roomId: 'room-1',
      participantId: 'guest-7',
      role: 'guest',
    });
  });

  it('rejects expired tokens of either kind', () => {
    assert.throws(() => verifySfuIdentity(hostToken({ exp: NOW - 1 }), SECRET, NOW));
    assert.throws(() => verifySfuIdentity(guestToken({ exp: NOW - 1 }), SECRET, NOW));
  });

  it('rejects tampered tokens', () => {
    const token = hostToken();
    const tampered = `${token.slice(0, -2)}xx`;
    assert.throws(() => verifySfuIdentity(tampered, SECRET, NOW));
  });

  it('rejects tokens signed with a different secret', () => {
    const otherSecret = 'another-secret-that-is-32-chars-long!!';
    assert.throws(() => verifySfuIdentity(hostToken(), otherSecret, NOW));
  });
});
