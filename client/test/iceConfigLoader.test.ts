import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_ICE_CONFIG, DEFAULT_ICE_CONFIG_STATUS, hasTurnServers, type ClientIceConfigWithStatus } from '../src/utils/iceConfig.ts';
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
});
