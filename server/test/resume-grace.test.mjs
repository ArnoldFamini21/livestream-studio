import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

delete process.env.SIGNALING_RESUME_GRACE_MS;
delete process.env.SIGNALING_GOING_AWAY_GRACE_MS;
const { getResumeGraceMs } = await import('../dist/services/signaling.js');

describe('seat hold after a closed connection', () => {
  it('drops at once for Leave, briefly for a closed tab or reload, and holds a dropped network for 30 s', () => {
    assert.equal(getResumeGraceMs(1000), 0, 'the studio Leave button');
    assert.equal(getResumeGraceMs(1005), 0, 'close() without a code');
    assert.equal(getResumeGraceMs(1001), 8_000, 'tab closed or page reloaded');
    assert.equal(getResumeGraceMs(1006), 30_000, 'network dropped');
    assert.equal(getResumeGraceMs(undefined), 30_000, 'missed heartbeat');
  });
});
