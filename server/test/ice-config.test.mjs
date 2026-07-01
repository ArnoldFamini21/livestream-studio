import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildIceConfigFromEnv, normalizeIceServer } from '../dist/services/ice-config.js';

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
    const config = buildIceConfigFromEnv({
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
});
