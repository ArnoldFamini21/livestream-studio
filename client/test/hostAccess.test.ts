import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  hasCreatedRoomDetails,
  resolveCreatedRoomHostAccess,
  type CreatedRoomResponse,
} from '../src/utils/hostAccess.ts';

const originalFetch = globalThis.fetch;
const VALID_HOST_TOKEN = 'RecoveredHostToken_1234567890';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('created room host access resolution', () => {
  it('uses create-room host tokens without calling recovery', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('recovery should not be called');
    };
    const room: CreatedRoomResponse = {
      id: 'token-room', name: 'Token room', hostName: 'Arnold', hostToken: VALID_HOST_TOKEN,
    };
    assert.equal(hasCreatedRoomDetails(room), true);
    const result = await resolveCreatedRoomHostAccess(room);
    assert.equal(result.legacyHostless, false);
    assert.equal(result.room.hostToken, VALID_HOST_TOKEN);
    assert.equal(called, false);
  });

  it('fails closed for missing or malformed private host credentials', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('an IP-based recovery must not be attempted');
    };
    for (const hostToken of [undefined, '', 'short', 12345, {}]) {
      await assert.rejects(resolveCreatedRoomHostAccess({
        id: 'stripped-room', name: 'Stripped room', hostToken,
      }), /private host credential/);
    }
    assert.equal(called, false);
  });

  it('rejects a legacy hostless response instead of accepting a local host marker', async () => {
    await assert.rejects(resolveCreatedRoomHostAccess({
      id: 'legacy-room', name: 'Legacy room', hostId: '', coHostIds: [], hostName: 'Arnold',
    }), /private host credential/);
  });
});
