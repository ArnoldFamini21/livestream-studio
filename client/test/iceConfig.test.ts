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

  it('keeps the default fallback TURN-capable', () => {
    assert.ok(DEFAULT_ICE_CONFIG.iceServers?.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
    }));
    assert.equal(DEFAULT_ICE_CONFIG_STATUS.turnReady, false);
    assert.equal(DEFAULT_ICE_CONFIG_STATUS.usingFallbackTurn, true);
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
