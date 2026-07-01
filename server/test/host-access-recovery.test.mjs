import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoom, getRooms, recoverHostAccess } from '../dist/services/signaling.js';

function uniqueCreatorIp(label) {
  return `host-access-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

describe('host access recovery', () => {
  it('recovers the host token for the original creator before the room is joined', () => {
    const creatorIp = uniqueCreatorIp('creator');
    const { room, hostToken } = createRoom('Recovery test', 'Arnold', { creatorIp });

    const result = recoverHostAccess(room.id, creatorIp);

    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' ? result.hostToken : '', hostToken);
    assert.equal(result.status === 'ok' ? result.room.id : '', room.id);
  });

  it('does not recover host access for a different creator IP', () => {
    const creatorIp = uniqueCreatorIp('owner');
    const { room } = createRoom('Recovery forbidden test', 'Arnold', { creatorIp });

    assert.deepEqual(recoverHostAccess(room.id, uniqueCreatorIp('attacker')), { status: 'forbidden' });
  });

  it('does not recover host access after the room has been joined', () => {
    const creatorIp = uniqueCreatorIp('joined');
    const { room } = createRoom('Recovery joined test', 'Arnold', { creatorIp });
    const state = getRooms().get(room.id);
    assert.ok(state);
    state.hasBeenJoined = true;

    assert.deepEqual(recoverHostAccess(room.id, creatorIp), { status: 'already_joined' });
  });

  it('expires recovery for old unjoined rooms', () => {
    const creatorIp = uniqueCreatorIp('expired');
    const { room } = createRoom('Recovery expired test', 'Arnold', { creatorIp });

    assert.deepEqual(recoverHostAccess(room.id, creatorIp, Number.MAX_SAFE_INTEGER), { status: 'expired' });
  });
});
