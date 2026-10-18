import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoom, getRooms, recoverHostAccess } from '../dist/services/signaling.js';

function uniqueCreatorIp(label) {
  return `host-access-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

describe('host access recovery', () => {
  it('returns host details only for a holder of the private credential', () => {
    const { room, hostToken } = createRoom('Credential recovery test', 'Arnold', {
      creatorIp: uniqueCreatorIp('owner'),
    });
    const result = recoverHostAccess(room.id, hostToken);
    assert.equal(result.status, 'ok');
    assert.equal(result.hostToken, hostToken);
    assert.equal(result.room.id, room.id);
  });

  it('never exchanges the creator IP or a missing credential for the private host token', () => {
    const creatorIp = uniqueCreatorIp('shared-network');
    const { room } = createRoom('Shared network recovery test', 'Arnold', { creatorIp });
    for (const claimedCredential of [creatorIp, undefined, '', 'wrong-token']) {
      assert.deepEqual(recoverHostAccess(room.id, claimedCredential), { status: 'forbidden' });
    }
  });

  it('allows a legitimate credential holder to recover details after joining', () => {
    const { room, hostToken } = createRoom('Joined credential recovery test', 'Arnold', {
      creatorIp: uniqueCreatorIp('joined'),
    });
    getRooms().get(room.id).hasBeenJoined = true;
    assert.equal(recoverHostAccess(room.id, hostToken).status, 'ok');
  });

  it('returns not found for an unknown room', () => {
    assert.deepEqual(recoverHostAccess('unknown-recovery-room', 'any-token'), { status: 'not_found' });
  });
});
