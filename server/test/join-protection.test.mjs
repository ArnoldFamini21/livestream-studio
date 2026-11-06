import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PasswordAttemptLimiter,
  SocketsPerIpLimiter,
  getUpgradeRequestIp,
} from '../dist/services/joinProtection.js';
import { WsRateLimiter, getWsRateBucket } from '../dist/services/wsRateLimit.js';
import { hashHostToken, signRoomRestoreTicket, verifyRoomRestoreTicket } from '../dist/services/roomRestoreTicket.js';

describe('join protection', () => {
  it('locks an address out after five wrong passwords, with growing lockouts', () => {
    const limiter = new PasswordAttemptLimiter({ maxFailures: 5, baseLockoutMs: 60_000, maxLockoutMs: 15 * 60_000, failureWindowMs: 15 * 60_000 });
    for (let i = 0; i < 4; i++) assert.equal(limiter.recordFailure('room', '1.2.3.4', i), 0);
    assert.equal(limiter.recordFailure('room', '1.2.3.4', 4), 60_000);
    assert.equal(limiter.lockedForMs('room', '1.2.3.4', 30_000), 30_004);
    assert.equal(limiter.lockedForMs('room', '5.6.7.8', 30_000), 0, 'other addresses are unaffected');
    assert.equal(limiter.lockedForMs('other-room', '1.2.3.4', 30_000), 0, 'other studios are unaffected');
    for (let i = 0; i < 4; i++) limiter.recordFailure('room', '1.2.3.4', 70_000 + i);
    assert.equal(limiter.recordFailure('room', '1.2.3.4', 70_010), 120_000, 'the second lockout doubles');
    limiter.recordSuccess('room', '1.2.3.4');
    assert.equal(limiter.lockedForMs('room', '1.2.3.4', 70_020), 0);
  });

  it('reads the client address the trusted proxy appended', () => {
    assert.equal(getUpgradeRequestIp({ headers: { 'x-forwarded-for': 'spoofed, 203.0.113.5' }, socket: { remoteAddress: '10.0.0.1' } }), '203.0.113.5');
    assert.equal(getUpgradeRequestIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
    assert.equal(getUpgradeRequestIp(undefined), 'unknown');
  });

  it('caps open sockets per address', () => {
    const limiter = new SocketsPerIpLimiter(2);
    assert.equal(limiter.tryAcquire('a'), true);
    assert.equal(limiter.tryAcquire('a'), true);
    assert.equal(limiter.tryAcquire('a'), false);
    limiter.release('a');
    assert.equal(limiter.tryAcquire('a'), true);
    assert.equal(limiter.tryAcquire('b'), true);
  });

  it('gives negotiation messages their own budget and notifies once per window', () => {
    const limiter = new WsRateLimiter({ control: 2, relay: 3 }, 1_000);
    const socket = {};
    assert.equal(getWsRateBucket('ice-candidate'), 'relay');
    assert.equal(getWsRateBucket('chat-message'), 'control');
    assert.equal(limiter.check(socket, 'chat-message', 0).allowed, true);
    assert.equal(limiter.check(socket, 'chat-message', 0).allowed, true);
    const limited = limiter.check(socket, 'chat-message', 0);
    assert.deepEqual(limited, { allowed: false, notify: true, bucket: 'control' });
    assert.equal(limiter.check(socket, 'chat-message', 0).notify, false);
    for (let i = 0; i < 3; i++) assert.equal(limiter.check(socket, 'offer', 0).allowed, true, 'chat floods do not block offers');
    assert.equal(limiter.check(socket, 'answer', 0).allowed, false);
    assert.equal(limiter.check(socket, 'chat-message', 2_000).allowed, true, 'a new window starts fresh');
  });

  it('signs restore tickets that only the host token holder can use', () => {
    const secret = 'restore-ticket-test-secret-at-least-32-chars';
    const hostToken = 'h'.repeat(32);
    const claims = {
      v: 1,
      purpose: 'room-restore',
      room: { id: 'room-1', name: 'Studio', createdAt: new Date(0).toISOString(), settings: { maxParticipants: 7 } },
      hostTokenHash: hashHostToken(hostToken),
      watchId: 'watch-id-abcdef',
      creatorIp: '1.2.3.4',
      iat: 0,
      exp: 10_000,
    };
    const ticket = signRoomRestoreTicket(claims, secret);
    assert.equal(verifyRoomRestoreTicket(ticket, secret, { roomId: 'room-1', hostToken }, 5_000)?.watchId, 'watch-id-abcdef');
    assert.equal(verifyRoomRestoreTicket(ticket, secret, { roomId: 'room-1', hostToken: 'x'.repeat(32) }, 5_000), null);
    assert.equal(verifyRoomRestoreTicket(ticket, secret, { roomId: 'room-2', hostToken }, 5_000), null);
    assert.equal(verifyRoomRestoreTicket(ticket, secret, { roomId: 'room-1', hostToken }, 20_000), null, 'expired');
    assert.equal(verifyRoomRestoreTicket(ticket, 'another-secret-that-is-long-enough-1234', { roomId: 'room-1', hostToken }, 5_000), null);
    const [body] = ticket.split('.');
    assert.equal(verifyRoomRestoreTicket(`${body}.tampered`, secret, { roomId: 'room-1', hostToken }, 5_000), null);
  });
});
