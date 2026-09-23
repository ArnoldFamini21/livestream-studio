import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('signaling liveness', () => {
  it('treats a connection as dead after 45 s of silence', async () => {
    const { isSignalingStale, SIGNALING_HEARTBEAT_INTERVAL_MS, SIGNALING_STALE_AFTER_MS } = await import('../src/utils/signalingRecovery.ts');
    assert.equal(isSignalingStale(1_000, 1_000 + 30_000), false);
    assert.equal(isSignalingStale(1_000, 1_000 + 46_000), true);
    assert.equal(isSignalingStale(0, 99_000), false, 'not yet connected');
    assert.ok(SIGNALING_STALE_AFTER_MS > SIGNALING_HEARTBEAT_INTERVAL_MS * 2, 'one lost heartbeat is tolerated');
  });
});
