import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  buildIceConfigFromEnv,
  buildIceConfigStatusFromEnv,
  buildIceConfigWithStatusFromEnv,
  clampTurnCredentialTtlSeconds,
  generateTurnRestCredential,
  normalizeIceServer,
} from '../dist/services/ice-config.js';

describe('ICE configuration', () => {
  it('normalizes valid STUN and TURN servers without leaking invalid URLs', () => {
    assert.deepEqual(normalizeIceServer({
      urls: ['stun:stun.example.com:19302', 'https://bad.example.com', 'turns:turn.example.com:443'],
      username: 'user',
      credential: 'secret',
      credentialType: 'password',
    }), {
      urls: ['stun:stun.example.com:19302', 'turns:turn.example.com:443'],
      username: 'user',
      credential: 'secret',
      credentialType: 'password',
    });

    assert.equal(normalizeIceServer({ urls: ['https://bad.example.com'] }), null);
  });

  it('prefers ICE_SERVERS_JSON when configured', () => {
    const config = buildIceConfigWithStatusFromEnv({
      ICE_SERVERS_JSON: JSON.stringify({
        iceTransportPolicy: 'relay',
        iceServers: [
          {
            urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443'],
            username: 'turn-user',
            credential: 'turn-secret',
          },
        ],
      }),
      STUN_URLS: 'stun:ignored.example.com:19302',
    });

    assert.deepEqual(config, {
      iceTransportPolicy: 'relay',
      iceServers: [
        {
          urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443'],
          username: 'turn-user',
          credential: 'turn-secret',
        },
      ],
      status: {
        source: 'ice_servers_json',
        serverCount: 1,
        stunServerCount: 0,
        turnServerCount: 1,
        hasTurn: true,
        hasConfiguredTurn: true,
        usingFallbackTurn: false,
        turnReady: true,
        iceTransportPolicy: 'relay',
      },
    });
  });

  it('builds config from split STUN and TURN env vars', () => {
    const config = buildIceConfigFromEnv({
      STUN_URLS: 'stun:stun1.example.com:19302, stun:stun2.example.com:19302',
      TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:443',
      TURN_USERNAME: 'relay-user',
      TURN_CREDENTIAL: 'relay-secret',
      ICE_TRANSPORT_POLICY: 'all',
    });

    assert.deepEqual(config, {
      iceTransportPolicy: 'all',
      iceServers: [
        { urls: ['stun:stun1.example.com:19302', 'stun:stun2.example.com:19302'] },
        {
          urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443'],
          username: 'relay-user',
          credential: 'relay-secret',
        },
      ],
    });
  });

  it('keeps a default TURN-capable fallback when env is absent or malformed', () => {
    const config = buildIceConfigFromEnv({ ICE_SERVERS_JSON: 'not json' });

    assert.equal(config.iceTransportPolicy, 'all');
    assert.ok(config.iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
    }));
  });

  it('reports default TURN fallback as not production ready', () => {
    const status = buildIceConfigStatusFromEnv({ ICE_SERVERS_JSON: 'not json' });

    assert.equal(status.source, 'default');
    assert.equal(status.hasTurn, true);
    assert.equal(status.hasConfiguredTurn, false);
    assert.equal(status.usingFallbackTurn, true);
    assert.equal(status.turnReady, false);
  });

  it('reports split env TURN credentials as production ready', () => {
    const status = buildIceConfigStatusFromEnv({
      STUN_URLS: 'stun:stun.example.com:19302',
      TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:443',
      TURN_USERNAME: 'relay-user',
      TURN_CREDENTIAL: 'relay-secret',
      ICE_TRANSPORT_POLICY: 'all',
    });

    assert.deepEqual(status, {
      source: 'split_env',
      serverCount: 2,
      stunServerCount: 1,
      turnServerCount: 1,
      hasTurn: true,
      hasConfiguredTurn: true,
      usingFallbackTurn: false,
      turnReady: true,
      iceTransportPolicy: 'all',
    });
  });

  it('does not report split STUN-only env as TURN ready', () => {
    const status = buildIceConfigStatusFromEnv({
      STUN_URLS: 'stun:stun.example.com:19302',
    });

    assert.equal(status.source, 'split_env');
    assert.equal(status.hasTurn, false);
    assert.equal(status.hasConfiguredTurn, false);
    assert.equal(status.turnReady, false);
  });

  it('generates coturn REST TURN credentials with an expiry and HMAC-SHA1 password', () => {
    const cred = generateTurnRestCredential('shared-secret', { ttlSeconds: 3600, userId: 'host-1', nowSeconds: 1_000 });
    assert.equal(cred.expiresAtSeconds, 4600);
    assert.equal(cred.username, '4600:host-1');
    const expected = createHmac('sha1', 'shared-secret').update('4600:host-1').digest('base64');
    assert.equal(cred.credential, expected);
  });

  it('sanitizes user ids and clamps the credential TTL', () => {
    const cred = generateTurnRestCredential('s', { userId: 'bad id/../x', nowSeconds: 0, ttlSeconds: 10 });
    assert.equal(cred.username.split(':')[1], 'badidx');
    assert.equal(clampTurnCredentialTtlSeconds('5'), 60);
    assert.equal(clampTurnCredentialTtlSeconds(999999999), 7 * 86400);
    assert.equal(clampTurnCredentialTtlSeconds('not-a-number'), 86400);
  });

  it('builds ephemeral TURN credentials from a static auth secret', () => {
    const config = buildIceConfigWithStatusFromEnv({
      STUN_URLS: 'stun:stun.example.com:19302',
      TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:443',
      TURN_STATIC_AUTH_SECRET: 'shared-secret',
      TURN_CREDENTIAL_TTL_SECONDS: '3600',
    }, { userId: 'host-9', nowSeconds: 2_000 });

    assert.equal(config.status.source, 'turn_rest_secret');
    assert.equal(config.status.hasConfiguredTurn, true);
    assert.equal(config.status.turnReady, true);
    const turn = config.iceServers.find((server) => String(server.urls).includes('turn:'));
    assert.equal(turn.username, '5600:host-9');
    assert.equal(turn.credentialType, 'password');
    const expected = createHmac('sha1', 'shared-secret').update('5600:host-9').digest('base64');
    assert.equal(turn.credential, expected);
  });

  it('ignores the static auth secret when no TURN urls are configured', () => {
    const status = buildIceConfigStatusFromEnv({
      TURN_STATIC_AUTH_SECRET: 'shared-secret',
    });
    assert.notEqual(status.source, 'turn_rest_secret');
  });
});
