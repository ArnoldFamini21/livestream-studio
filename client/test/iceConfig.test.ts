import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_ICE_CONFIG, normalizeIceConfig } from '../src/utils/iceConfig.ts';

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
  });
});
