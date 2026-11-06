import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildConnectionCheckResult,
  measureServerRtt,
  rateServerRtt,
  runConnectionCheck,
} from '../src/utils/connectionCheck.ts';

function steppingClock(steps: number[]) {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)];
}

describe('pre-join connection check', () => {
  it('reports the median server round trip and skips lost samples', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 2) throw new TypeError('offline');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    // start/end pairs: 100ms, (lost), 300ms
    const now = steppingClock([0, 100, 1000, 2000, 2300]);
    const rtt = await measureServerRtt({ fetchImpl, now, healthUrl: '/health', samples: 3 });
    assert.equal(rtt, 200);
  });

  it('returns null when the server never answers', async () => {
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    assert.equal(await measureServerRtt({ fetchImpl, healthUrl: '/health', samples: 2 }), null);
  });

  it('rates round trips', () => {
    assert.equal(rateServerRtt(120), 'good');
    assert.equal(rateServerRtt(500), 'warning');
    assert.equal(rateServerRtt(1500), 'bad');
    assert.equal(rateServerRtt(null), 'bad');
  });

  it('is good with a direct path and a relay ready after joining', () => {
    const result = buildConnectionCheckResult(150, { host: true, srflx: true, relay: false }, { configured: true, verified: false });
    assert.equal(result.level, 'good');
    assert.match(result.items.find((item) => item.id === 'relay')!.detail, /once you join/);
  });

  it('warns when only a relay can connect, and fails with no path at all', () => {
    const relayOnly = buildConnectionCheckResult(150, { host: true, srflx: false, relay: false }, { configured: true, verified: false });
    assert.equal(relayOnly.level, 'warning');
    const blocked = buildConnectionCheckResult(150, { host: false, srflx: false, relay: false }, { configured: false, verified: false });
    assert.equal(blocked.level, 'bad');
  });

  it('runs the whole check with the relay flag from the server', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    let gatheredWith: RTCConfiguration | null = null;
    const result = await runConnectionCheck({
      fetchImpl,
      healthUrl: '/health',
      samples: 1,
      loadIceConfig: async () => ({ iceServers: [{ urls: 'stun:stun.example.test' }], relayConfigured: true }),
      gatherCandidates: async (config) => { gatheredWith = config; return { host: true, srflx: true, relay: false }; },
    });
    assert.equal(result.level, 'good');
    assert.deepEqual(gatheredWith!.iceServers, [{ urls: 'stun:stun.example.test' }]);
  });
});
