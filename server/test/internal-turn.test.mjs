import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  getInternalTurnSecret,
  INTERNAL_TURN_MAX_SKEW_SECONDS,
  signInternalTurnRequest,
  verifyInternalTurnSignature,
} from '../dist/services/internalTurn.js';
import { mintCloudflareTurnForSfu, resetCloudflareTurnCache, resolveIceConfigWithStatus } from '../dist/services/ice-config.js';

const SECRET = 'y'.repeat(40);
const NOW = 1_700_000_000;

describe('internal SFU TURN endpoint auth', () => {
  it('accepts a fresh signature over "studio-sfu-turn:v1:<seconds>"', () => {
    const sig = createHmac('sha256', SECRET).update(`studio-sfu-turn:v1:${NOW}`).digest('base64url');
    assert.equal(signInternalTurnRequest(SECRET, NOW), `${NOW}.${sig}`);
    assert.equal(verifyInternalTurnSignature(`${NOW}.${sig}`, SECRET, NOW), true);
    assert.equal(verifyInternalTurnSignature(signInternalTurnRequest(SECRET, NOW - 60), SECRET, NOW), true);
  });

  it('rejects stale, future, wrong-secret, malformed and missing signatures', () => {
    const skew = INTERNAL_TURN_MAX_SKEW_SECONDS + 1;
    assert.equal(verifyInternalTurnSignature(signInternalTurnRequest(SECRET, NOW - skew), SECRET, NOW), false);
    assert.equal(verifyInternalTurnSignature(signInternalTurnRequest(SECRET, NOW + skew), SECRET, NOW), false);
    assert.equal(verifyInternalTurnSignature(signInternalTurnRequest('z'.repeat(40), NOW), SECRET, NOW), false);
    assert.equal(verifyInternalTurnSignature(`${NOW}.abc`, SECRET, NOW), false);
    assert.equal(verifyInternalTurnSignature(`${NOW}`, SECRET, NOW), false);
    assert.equal(verifyInternalTurnSignature(undefined, SECRET, NOW), false);
    assert.equal(verifyInternalTurnSignature(signInternalTurnRequest(SECRET, NOW), null, NOW), false, 'no secret, no access');
  });

  it('uses the shared token secret, never a dev secret in production', () => {
    assert.equal(getInternalTurnSecret({ NODE_ENV: 'production', LIVE_STREAM_TOKEN_SECRET: SECRET }), SECRET);
    assert.equal(getInternalTurnSecret({ NODE_ENV: 'production', LIVE_STREAM_TOKEN_SECRET: 'short' }), null);
    assert.equal(getInternalTurnSecret({ NODE_ENV: 'production' }), null);
    assert.equal(getInternalTurnSecret({}), 'development-live-stream-token-secret');
  });
});

describe('mintCloudflareTurnForSfu', () => {
  const ENV = { CLOUDFLARE_TURN_KEY_ID: 'key', CLOUDFLARE_TURN_API_TOKEN: 'token' };
  const BODY = { iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] };
  const ok = async () => ({ ok: true, status: 200, json: async () => BODY });

  it('returns null when Cloudflare is not configured', async () => {
    assert.equal(await mintCloudflareTurnForSfu({}), null);
  });

  it('always mints fresh and leaves the browser cache alone', async () => {
    resetCloudflareTurnCache();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return ok(); };
    const first = await mintCloudflareTurnForSfu(ENV, { fetchImpl, now: 0 });
    assert.equal(first.ttlSeconds, 86_400);
    assert.equal(first.iceServers[0].username, 'u');
    await mintCloudflareTurnForSfu(ENV, { fetchImpl, now: 1 });
    assert.equal(calls, 2, 'never served from cache');
    await resolveIceConfigWithStatus(ENV, { fetchImpl, now: 2 });
    assert.equal(calls, 3, 'the browser cache was not filled by the SFU mint');
    resetCloudflareTurnCache();
  });
});
