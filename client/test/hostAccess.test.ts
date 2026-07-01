import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  hasCreatedRoomDetails,
  resolveCreatedRoomHostAccess,
  type CreatedRoomResponse,
} from '../src/utils/hostAccess.ts';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const VALID_HOST_TOKEN = 'RecoveredHostToken_1234567890';

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe('created room host access resolution', () => {
  it('uses create-room host tokens without calling recovery', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('recovery should not be called');
    };

    const room: CreatedRoomResponse = {
      id: 'token-room',
      name: 'Token room',
      hostName: 'Arnold',
      hostToken: VALID_HOST_TOKEN,
    };

    assert.equal(hasCreatedRoomDetails(room), true);
    const result = await resolveCreatedRoomHostAccess(room);

    assert.equal(result.legacyHostless, false);
    assert.equal(result.room.hostToken, VALID_HOST_TOKEN);
    assert.equal(called, false);
  });

  it('recovers host tokens when a modern server can restore access', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        id: 'stripped-room',
        name: 'Recovered room',
        hostName: 'Arnold',
        hostToken: VALID_HOST_TOKEN,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const room: CreatedRoomResponse = {
      id: 'stripped-room',
      name: 'Stripped room',
      hostName: 'Arnold',
    };

    assert.equal(hasCreatedRoomDetails(room), true);
    const result = await resolveCreatedRoomHostAccess(room);

    assert.equal(requestedUrl, '/api/rooms/stripped-room/host-access');
    assert.equal(result.legacyHostless, false);
    assert.equal(result.room.name, 'Recovered room');
    assert.equal(result.room.hostToken, VALID_HOST_TOKEN);
  });

  it('uses same-tab legacy host mode immediately when create prefers old server fallback', async () => {
    let called = false;
    console.warn = () => {};
    globalThis.fetch = async () => {
      called = true;
      throw new Error('recovery should be skipped');
    };

    const room: CreatedRoomResponse = {
      id: 'legacy-immediate-room',
      name: 'Legacy immediate room',
      hostId: '',
      coHostIds: [],
      hostName: 'Arnold',
    };

    assert.equal(hasCreatedRoomDetails(room), true);
    const result = await resolveCreatedRoomHostAccess(room, { preferLegacyFallback: true });

    assert.equal(called, false);
    assert.equal(result.legacyHostless, true);
    assert.equal(result.room.id, 'legacy-immediate-room');
    assert.equal(result.room.hostToken, undefined);
  });

  it('falls back to same-tab legacy host mode when old servers have no recovery route', async () => {
    let requestedUrl = '';
    console.warn = () => {};
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response('<!doctype html><pre>Cannot POST /host-access</pre>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    };

    const room: CreatedRoomResponse = {
      id: 'legacy-room',
      name: 'Legacy room',
      hostId: '',
      coHostIds: [],
      hostName: 'Arnold',
      settings: {
        passwordProtected: false,
      },
    };

    assert.equal(hasCreatedRoomDetails(room), true);
    const result = await resolveCreatedRoomHostAccess(room);

    assert.equal(requestedUrl, '/api/rooms/legacy-room/host-access');
    assert.equal(result.legacyHostless, true);
    assert.equal(result.room.id, 'legacy-room');
    assert.equal(result.room.hostToken, undefined);
  });
});
