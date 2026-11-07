import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecordingUploadRevocations } from './uploadRevocations.js';

describe('recording upload revocations', () => {
  it('refuses tokens issued before a participant was removed, but not other participants or later tokens', () => {
    const revocations = new RecordingUploadRevocations(60_000);
    revocations.revoke('room-1', 'guest-a', 10_000);

    assert.equal(revocations.isRevoked('room-1', 'guest-a', 9_000, 11_000), true);
    assert.equal(revocations.isRevoked('room-1', 'guest-a', 10_000, 11_000), true);
    assert.equal(revocations.isRevoked('room-1', 'guest-a', 12_000, 13_000), false, 'a token issued after rejoining is fine');
    assert.equal(revocations.isRevoked('room-1', 'guest-b', 9_000, 11_000), false);
    assert.equal(revocations.isRevoked('room-2', 'guest-a', 9_000, 11_000), false);
  });

  it('treats a token without an issue time as revoked once its holder is revoked', () => {
    const revocations = new RecordingUploadRevocations(60_000);
    assert.equal(revocations.isRevoked('room-1', 'guest-a', undefined, 1_000), false);
    revocations.revoke('room-1', 'guest-a', 2_000);
    assert.equal(revocations.isRevoked('room-1', 'guest-a', undefined, 3_000), true);
  });

  it('forgets revocations after their lifetime', () => {
    const revocations = new RecordingUploadRevocations(1_000);
    revocations.revoke('room-1', 'guest-a', 0);
    assert.equal(revocations.isRevoked('room-1', 'guest-a', 0, 500), true);
    assert.equal(revocations.isRevoked('room-1', 'guest-a', 0, 5_000), false);
    revocations.revoke('room-1', 'guest-b', 10_000);
    revocations.sweep(20_000);
    assert.equal(revocations.size, 0);
  });
});
