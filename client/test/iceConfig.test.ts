import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ICE_CONFIG,
  DEFAULT_ICE_CONFIG_STATUS,
  normalizeIceConfig,
  normalizeIceConfigWithStatus,
} from '../src/utils/iceConfig.ts';

describe('ICE configuration helpers', () => {
  it('normalizes server-provided STUN and TURN config', () => {
    assert.deepEqual(normalizeIceConfig({
      iceTransportPolicy: 'relay',
      iceServers: [
        {
          urls: ['stun:stun.example.com:19302', 'https://bad.example.com', 'turn:turn.example.com:3478'],
          username: 'turn-user',
          credential: 'turn-secret',
          credentialType: 'password',
        },
      ],
    }), {
      iceTransportPolicy: 'relay',
      iceServers: [
        {
          urls: ['stun:stun.example.com:19302', 'turn:turn.example.com:3478'],
          username: 'turn-user',
          credential: 'turn-secret',
          credentialType: 'password',
        },
      ],
    });
  });

  it('rejects malformed endpoint payloads', () => {
    assert.equal(normalizeIceConfig(null), null);
    assert.equal(normalizeIceConfig({ iceServers: [] }), null);
    assert.equal(normalizeIceConfig({ iceServers: [{ urls: 'https://not-ice.example.com' }] }), null);
  });

  it('ships no static relay password in the offline fallback', () => {
    // Relay credentials are short-lived and minted by the server.
    assert.ok(DEFAULT_ICE_CONFIG.iceServers?.every((server) => !server.username && !server.credential));
    assert.ok(DEFAULT_ICE_CONFIG.iceServers?.some((server) => String(server.urls).startsWith('stun:')));
    assert.equal(DEFAULT_ICE_CONFIG_STATUS.turnReady, false);
    assert.equal(DEFAULT_ICE_CONFIG_STATUS.hasTurn, false);
  });

  it('accepts Cloudflare as a configured relay source', () => {
    const result = normalizeIceConfigWithStatus({
      iceServers: [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }],
      status: { source: 'cloudflare', hasTurn: true, hasConfiguredTurn: true, turnReady: true, usingFallbackTurn: false },
    });
    assert.equal(result?.status.source, 'cloudflare');
    assert.equal(result?.status.turnReady, true);
  });

  it('preserves server-provided production TURN readiness metadata', () => {
    const normalized = normalizeIceConfigWithStatus({
      iceTransportPolicy: 'all',
      iceServers: [
        {
          urls: ['stun:stun.example.com:19302', 'turns:turn.example.com:443'],
          username: 'turn-user',
          credential: 'turn-secret',
        },
      ],
      status: {
        source: 'split_env',
        serverCount: 1,
        stunServerCount: 1,
        turnServerCount: 1,
        hasTurn: true,
        hasConfiguredTurn: true,
        usingFallbackTurn: false,
        turnReady: true,
        iceTransportPolicy: 'all',
      },
    });

    assert.deepEqual(normalized?.status, {
      source: 'split_env',
      serverCount: 1,
      stunServerCount: 1,
      turnServerCount: 1,
      hasTurn: true,
      hasConfiguredTurn: true,
      usingFallbackTurn: false,
      turnReady: true,
      iceTransportPolicy: 'all',
    });
  });

  it('does not trust TURN-ready status without configured TURN credentials', () => {
    const normalized = normalizeIceConfigWithStatus({
      iceTransportPolicy: 'all',
      iceServers: [
        {
          urls: ['turns:turn.example.com:443'],
          username: 'turn-user',
          credential: 'turn-secret',
        },
      ],
      status: {
        source: 'default',
        serverCount: -5,
        stunServerCount: 'bad',
        turnServerCount: 1,
        hasTurn: true,
        hasConfiguredTurn: false,
        usingFallbackTurn: true,
        turnReady: true,
        iceTransportPolicy: 'relay',
      },
    });

    assert.equal(normalized?.status.turnReady, false);
    assert.equal(normalized?.status.serverCount, 1);
    assert.equal(normalized?.status.usingFallbackTurn, true);
    assert.equal(normalized?.status.iceTransportPolicy, 'relay');
  });
});
