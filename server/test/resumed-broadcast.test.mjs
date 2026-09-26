import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getResumedLiveStartedAt } from '../dist/services/signaling.js';

describe('getResumedLiveStartedAt', () => {
  const now = Date.parse('2026-09-26T10:00:00.000Z');

  it('keeps the start time of a broadcast resumed after a dropped connection', () => {
    assert.equal(getResumedLiveStartedAt('2026-09-26T09:15:00.000Z', now), '2026-09-26T09:15:00.000Z');
  });

  it('ignores missing, malformed, future, and day-old start times', () => {
    assert.equal(getResumedLiveStartedAt(undefined, now), undefined);
    assert.equal(getResumedLiveStartedAt(12345, now), undefined);
    assert.equal(getResumedLiveStartedAt('yesterday', now), undefined);
    assert.equal(getResumedLiveStartedAt('2026-09-26T10:05:00.000Z', now), undefined);
    assert.equal(getResumedLiveStartedAt('2026-09-25T09:00:00.000Z', now), undefined);
  });
});
