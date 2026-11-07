import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSfuIceConfigProvider,
  parseCloudflareSfuIceServers,
  readSfuTurnEnv,
} from './sfuIceServers.js';

const CLOUDFLARE_BODY = {
  iceServers: [
    {
      urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'],
    },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'user',
      credential: 'secret',
    },
  ],
};

const ENV = { CLOUDFLARE_TURN_KEY_ID: 'key', CLOUDFLARE_TURN_API_TOKEN: 'token' } as NodeJS.ProcessEnv;

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('SFU TURN configuration', () => {
  it('reads the same Cloudflare variables as the signaling server', () => {
    assert.equal(readSfuTurnEnv({}), null);
    assert.equal(readSfuTurnEnv({ CLOUDFLARE_TURN_KEY_ID: 'key' }), null);
    assert.deepEqual(readSfuTurnEnv(ENV), { keyId: 'key', apiToken: 'token', transport: 'udp' });
    assert.equal(readSfuTurnEnv({ ...ENV, SFU_TURN_TRANSPORT: 'TCP' })?.transport, 'tcp');
    assert.equal(readSfuTurnEnv({ ...ENV, SFU_TURN_TRANSPORT: 'carrier-pigeon' })?.transport, 'udp');
  });

  it('flattens servers, drops port 53 and puts the preferred TURN transport first for werift', () => {
    const udp = parseCloudflareSfuIceServers(CLOUDFLARE_BODY, 'udp');
    assert.deepEqual(udp.map((server) => server.urls), [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'stun:stun.cloudflare.com:3478',
    ]);
    assert.deepEqual(udp[0], { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'user', credential: 'secret' });
    assert.deepEqual(udp[3], { urls: 'stun:stun.cloudflare.com:3478' }, 'STUN carries no credentials');
    assert.equal(parseCloudflareSfuIceServers(CLOUDFLARE_BODY, 'tls')[0].urls, 'turns:turn.cloudflare.com:5349?transport=tcp');
    assert.deepEqual(parseCloudflareSfuIceServers({ iceServers: [{ urls: 'turn:x:3478' }] }), [], 'TURN without credentials is useless');
    assert.deepEqual(parseCloudflareSfuIceServers(null), []);
  });

  it('returns null without TURN variables, so the SFU behaves as before', async () => {
    let fetched = 0;
    const logs: string[] = [];
    const provider = createSfuIceConfigProvider({
      env: {},
      fetchImpl: (async () => { fetched += 1; return okResponse(CLOUDFLARE_BODY); }) as typeof fetch,
      log: (message) => logs.push(message),
    });
    assert.equal(await provider(), null);
    assert.equal(await provider(), null);
    assert.equal(fetched, 0);
    assert.equal(logs.length, 1, 'warns once');
  });

  it('mints relay-only credentials once, shares them, and refreshes at half their lifetime', async () => {
    let now = 1_000_000;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createSfuIceConfigProvider({
      env: ENV,
      now: () => now,
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return okResponse(CLOUDFLARE_BODY);
      }) as unknown as typeof fetch,
    });
    const [first, second] = await Promise.all([provider(), provider()]);
    assert.equal(requests.length, 1, 'concurrent peers share one request');
    assert.equal(first, second);
    assert.equal(first?.iceTransportPolicy, 'relay');
    assert.equal(first?.iceServers[0].urls, 'turn:turn.cloudflare.com:3478?transport=udp');
    assert.equal(requests[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers');
    assert.equal((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer token');

    now += 11 * 3600 * 1000;
    await provider();
    assert.equal(requests.length, 1);
    now += 2 * 3600 * 1000;
    await provider();
    assert.equal(requests.length, 2);
  });

  it('keeps valid credentials through a failed refresh and backs off before retrying', async () => {
    let now = 0;
    let fail = false;
    let calls = 0;
    const logs: string[] = [];
    const provider = createSfuIceConfigProvider({
      env: ENV,
      now: () => now,
      log: (message) => logs.push(message),
      fetchImpl: (async () => {
        calls += 1;
        if (fail) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
        return okResponse(CLOUDFLARE_BODY);
      }) as typeof fetch,
    });
    const good = await provider();
    fail = true;
    now += 13 * 3600 * 1000;
    assert.equal(await provider(), good, 'old credentials are still valid');
    assert.match(logs[0], /503/);
    await provider();
    assert.equal(calls, 2, 'no retry storm');
    now += 12 * 3600 * 1000;
    assert.equal(await provider(), null, 'expired credentials are not handed out');
  });

  it('returns null when Cloudflare answers without a relay', async () => {
    const provider = createSfuIceConfigProvider({
      env: ENV,
      log: () => {},
      fetchImpl: (async () => okResponse({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })) as typeof fetch,
    });
    assert.equal(await provider(), null);
  });
});
