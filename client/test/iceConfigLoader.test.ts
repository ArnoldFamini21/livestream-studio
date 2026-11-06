import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ICE_CONFIG,
  DEFAULT_ICE_CONFIG_STATUS,
  buildIceConfigRequestHeaders,
  getIceConfigCredentials,
  hasTurnServers,
  setIceConfigCredentials,
  type ClientIceConfigWithStatus,
} from '../src/utils/iceConfig.ts';
import { IceConfigLoader, getIceConfigRetryDelayMs } from '../src/utils/iceConfigLoader.ts';

const turnConfig: ClientIceConfigWithStatus = {
  config: {
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ],
    iceTransportPolicy: 'all',
  },
  status: { ...DEFAULT_ICE_CONFIG_STATUS, source: 'cloudflare', turnServerCount: 1, hasTurn: true, hasConfiguredTurn: true, turnReady: true },
};

describe('shared ICE configuration loader', () => {
  it('lets calls start on STUN when the sleeping server does not answer, then delivers TURN when it wakes', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const loader = new IceConfigLoader({
      fetchConfig: async () => {
        attempts++;
        if (attempts < 4) throw new Error('timed out');
        return turnConfig;
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const updates: ClientIceConfigWithStatus[] = [];
    loader.subscribe((value) => updates.push(value));

    const first = await loader.ready();
    assert.equal(first.config, DEFAULT_ICE_CONFIG, 'the first failure hands out the fallback at once');
    assert.equal(hasTurnServers(first.config), false);

    for (let i = 0; i < 20 && updates.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 4);
    assert.deepEqual(sleeps, [2_000, 4_000, 8_000]);
    assert.equal(updates.length, 1);
    assert.equal(loader.latest, turnConfig);
    assert.equal(hasTurnServers(loader.latest.config), true);
    assert.equal(loader.loaded, true);
  });

  it('fetches once for everyone and refreshes stale credentials in the background', async () => {
    let now = 0;
    let fetches = 0;
    const loader = new IceConfigLoader({
      fetchConfig: async () => { fetches++; return turnConfig; },
      now: () => now,
      maxAgeMs: 1_000,
    });
    await Promise.all([loader.ready(), loader.ready(), loader.ready()]);
    assert.equal(fetches, 1);
    loader.refreshIfStale();
    assert.equal(fetches, 1);
    now = 5_000;
    loader.refreshIfStale();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 2);
  });

  it('backs off up to a minute between attempts', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 8].map(getIceConfigRetryDelayMs), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('refetches with the seat credential once the page joins a studio, so TURN replaces the STUN-only answer', async () => {
    setIceConfigCredentials(null);
    const stunOnly: ClientIceConfigWithStatus = { config: DEFAULT_ICE_CONFIG, status: DEFAULT_ICE_CONFIG_STATUS };
    const seenHeaders: Array<Record<string, string>> = [];
    const loader = new IceConfigLoader({
      fetchConfig: async () => {
        const headers = buildIceConfigRequestHeaders();
        seenHeaders.push(headers);
        return headers['X-Room-Credential'] ? turnConfig : stunOnly;
      },
    });
    const updates: ClientIceConfigWithStatus[] = [];
    loader.subscribe((value) => updates.push(value));
    await loader.ready();
    assert.equal(hasTurnServers(loader.latest.config), false, 'before joining only STUN is handed out');

    loader.setCredentials({ roomId: 'room-1', credential: 'seat-secret-aaaaaaaaaaaa' });
    for (let i = 0; i < 10 && updates.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seenHeaders[1], { 'X-Room-Id': 'room-1', 'X-Room-Credential': 'seat-secret-aaaaaaaaaaaa' });
    assert.equal(loader.latest, turnConfig);

    // A rotated credential for the same seat does not refetch.
    loader.setCredentials({ roomId: 'room-1', credential: 'seat-secret-bbbbbbbbbbbb' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seenHeaders.length, 2);
    assert.equal(getIceConfigCredentials()?.credential, 'seat-secret-bbbbbbbbbbbb', 'later refreshes use the new credential');
    setIceConfigCredentials(null);
    assert.deepEqual(buildIceConfigRequestHeaders(), {});
  });

  it('makes a connection created right after joining wait for the seat configuration', async () => {
    setIceConfigCredentials(null);
    const stunOnly: ClientIceConfigWithStatus = { config: DEFAULT_ICE_CONFIG, status: DEFAULT_ICE_CONFIG_STATUS };
    let releaseSeatFetch: () => void = () => {};
    const loader = new IceConfigLoader({
      fetchConfig: async () => {
        if (!buildIceConfigRequestHeaders()['X-Room-Credential']) return stunOnly;
        await new Promise<void>((resolve) => { releaseSeatFetch = resolve; });
        return turnConfig;
      },
    });
    await loader.ready();
    // Without a seat there is nothing more to wait for.
    assert.equal(await loader.readyForSeat(50), stunOnly);

    loader.setCredentials({ roomId: 'room-2', credential: 'seat-secret-cccccccccccc' });
    const pending = loader.readyForSeat(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    releaseSeatFetch();
    assert.equal(await pending, turnConfig, 'the SFU starts with TURN, not the pre-join STUN answer');
    // Already seated: resolves at once.
    assert.equal(await loader.readyForSeat(50), turnConfig);
    setIceConfigCredentials(null);
  });
});
