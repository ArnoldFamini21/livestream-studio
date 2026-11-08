import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  createSfuIceConfigProvider,
  DEFAULT_SIGNALING_SERVER_URL,
  parseCloudflareSfuIceServers,
  readSfuSignalingTurnSource,
  readSfuTurnEnv,
  signInternalTurnRequest,
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

  const SECRET = 'x'.repeat(40);
  const PROD = { NODE_ENV: 'production', LIVE_STREAM_TOKEN_SECRET: SECRET } as NodeJS.ProcessEnv;

  it('falls back to the signaling server, signed with the shared secret', () => {
    assert.deepEqual(readSfuSignalingTurnSource(PROD), {
      endpoint: `${DEFAULT_SIGNALING_SERVER_URL}/internal/sfu-turn-credentials`,
      secret: SECRET,
      transport: 'udp',
    });
    assert.equal(readSfuSignalingTurnSource({ NODE_ENV: 'production' }), null, 'no shared secret in production');
    assert.equal(readSfuSignalingTurnSource({ NODE_ENV: 'production', LIVE_STREAM_TOKEN_SECRET: 'short' }), null);
    assert.equal(readSfuSignalingTurnSource({ ...PROD, SIGNALING_SERVER_URL: 'off' }), null);
    assert.equal(readSfuSignalingTurnSource({ ...PROD, SIGNALING_SERVER_URL: 'http://example.com' }), null, 'credentials never over plain HTTP');
    assert.equal(readSfuSignalingTurnSource({ ...PROD, SIGNALING_SERVER_URL: 'not a url' }), null);
    assert.equal(
      readSfuSignalingTurnSource({ ...PROD, SIGNALING_SERVER_URL: 'https://api.example.com/some/path' })?.endpoint,
      'https://api.example.com/internal/sfu-turn-credentials'
    );
    assert.equal(readSfuSignalingTurnSource({}), null, 'dev needs SIGNALING_SERVER_URL');
    assert.equal(readSfuSignalingTurnSource({ SIGNALING_SERVER_URL: 'http://localhost:3001' })?.secret, 'development-live-stream-token-secret');
  });

  it('signs "studio-sfu-turn:v1:<seconds>" with HMAC-SHA256, matching the server', () => {
    const expected = createHmac('sha256', SECRET).update('studio-sfu-turn:v1:1700000000').digest('base64url');
    assert.equal(signInternalTurnRequest(SECRET, 1700000000), `1700000000.${expected}`);
  });

  it('gets relay credentials from the signaling server when it has no Cloudflare key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let time = 1_700_000_000_000;
    const provider = createSfuIceConfigProvider({
      env: PROD,
      now: () => time,
      log: () => {},
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return okResponse({ ...CLOUDFLARE_BODY, ttlSeconds: 86_400 });
      }) as unknown as typeof fetch,
    });
    const config = await provider();
    assert.equal(config?.iceTransportPolicy, 'relay');
    assert.equal(config?.iceServers[0].urls, 'turn:turn.cloudflare.com:3478?transport=udp');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_SIGNALING_SERVER_URL}/internal/sfu-turn-credentials`);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Studio-Internal-Signature'], signInternalTurnRequest(SECRET, 1_700_000_000));
    assert.equal(JSON.stringify(calls[0].init).includes('Bearer'), false, 'no Cloudflare token involved');
    await provider();
    assert.equal(calls.length, 1, 'cached');
    time += 12 * 3600_000 + 1;
    await provider();
    assert.equal(calls.length, 2, 'refreshed at half the lifetime');
  });

  it('prefers its own Cloudflare key over the signaling server', async () => {
    const urls: string[] = [];
    const provider = createSfuIceConfigProvider({
      env: { ...PROD, ...ENV },
      log: () => {},
      fetchImpl: (async (url: string) => { urls.push(url); return okResponse(CLOUDFLARE_BODY); }) as unknown as typeof fetch,
    });
    await provider();
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/rtc\.live\.cloudflare\.com\//);
  });

  it('returns null and backs off when the signaling server refuses', async () => {
    let fetched = 0;
    const logs: string[] = [];
    let time = 0;
    const provider = createSfuIceConfigProvider({
      env: PROD,
      now: () => time,
      log: (message) => logs.push(message),
      fetchImpl: (async () => { fetched += 1; return { ok: false, status: 401, json: async () => ({}) } as unknown as Response; }) as unknown as typeof fetch,
    });
    assert.equal(await provider(), null);
    assert.equal(await provider(), null);
    assert.equal(fetched, 1, 'no retry inside the back-off window');
    assert.match(logs[0], /signaling server returned 401/);
    time += 31_000;
    await provider();
    assert.equal(fetched, 2);
  });
});

