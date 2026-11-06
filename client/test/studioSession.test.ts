import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ROOM_LOST_RETRY_WINDOW_MS,
  buildStudioJoinPayload,
  getRoomLostRetryDelayMs,
  getStudioRestoreTicket,
  getStudioResumeToken,
  saveStudioRestoreTicket,
  saveStudioResumeToken,
  shouldKeepRetryingLostRoom,
} from '../src/utils/studioSession.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('studio seat resume', () => {
  it('stores resume tokens per studio and restore tickets per studio', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    saveStudioResumeToken('room-a', 'token-a', session);
    saveStudioRestoreTicket('room-a', 'ticket-a', local);
    assert.equal(getStudioResumeToken('room-a', session), 'token-a');
    assert.equal(getStudioResumeToken('room-b', session), undefined);
    assert.equal(getStudioRestoreTicket('room-a', local), 'ticket-a');
    saveStudioResumeToken('room-a', null, session);
    assert.equal(getStudioResumeToken('room-a', session), undefined);
  });

  it('does not re-send spent single-use invite tokens once a seat can be resumed', () => {
    const first = buildStudioJoinPayload({ roomId: 'r', name: 'Pastor', role: 'co-host', coHostInviteToken: 'invite', joinSessionId: 'browser-1' });
    assert.equal(first.coHostInviteToken, 'invite');
    const rejoin = buildStudioJoinPayload({ roomId: 'r', name: 'Pastor', role: 'co-host', coHostInviteToken: 'invite', joinSessionId: 'browser-1', resumeToken: 'resume' });
    assert.equal(rejoin.coHostInviteToken, undefined);
    assert.equal(rejoin.resumeToken, 'resume');
    assert.equal(rejoin.joinSessionId, 'browser-1');

    const secureGuest = buildStudioJoinPayload({ roomId: 'r', name: 'Guest', role: 'guest', guestInviteToken: 'secure', resumeToken: 'resume' });
    assert.equal(secureGuest.guestInviteToken, undefined);
  });

  it('sends host credentials only for the host, and the password only for guests', () => {
    const host = buildStudioJoinPayload({ roomId: 'r', name: 'Arnold', role: 'host', hostToken: 'h', restoreTicket: 't', roomPassword: 'p' });
    assert.equal(host.hostToken, 'h');
    assert.equal(host.restoreTicket, 't');
    assert.equal(host.roomPassword, undefined);
    const guest = buildStudioJoinPayload({ roomId: 'r', name: 'G', role: 'guest', hostToken: 'h', restoreTicket: 't', roomPassword: 'p' });
    assert.equal(guest.hostToken, undefined);
    assert.equal(guest.restoreTicket, undefined);
    assert.equal(guest.roomPassword, 'p');
  });

  it('keeps retrying a studio the server forgot for a few minutes, with growing waits', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(getRoomLostRetryDelayMs), [2_000, 4_000, 8_000, 15_000, 15_000]);
    assert.equal(shouldKeepRetryingLostRoom(0, ROOM_LOST_RETRY_WINDOW_MS - 1), true);
    assert.equal(shouldKeepRetryingLostRoom(0, ROOM_LOST_RETRY_WINDOW_MS + 1), false);
  });
});
