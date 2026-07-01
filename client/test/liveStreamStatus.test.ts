import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLiveStreamElapsedSeconds,
  getLiveStreamStatus,
} from '../src/utils/liveStreamStatus.ts';

describe('live stream status', () => {
  it('calculates elapsed seconds from the authoritative start time', () => {
    assert.equal(
      getLiveStreamElapsedSeconds('2026-06-11T12:00:00.000Z', Date.parse('2026-06-11T12:01:05.000Z')),
      65,
    );
  });

  it('bounds invalid or future start times to zero elapsed seconds', () => {
    assert.equal(getLiveStreamElapsedSeconds(null), 0);
    assert.equal(getLiveStreamElapsedSeconds('not-a-date'), 0);
    assert.equal(
      getLiveStreamElapsedSeconds('2026-06-11T12:05:00.000Z', Date.parse('2026-06-11T12:00:00.000Z')),
      0,
    );
  });

  it('formats active live stream duration for the studio header', () => {
    assert.deepEqual(getLiveStreamStatus({
      live: true,
      startedAt: '2026-06-11T12:00:00.000Z',
      elapsedSeconds: 3661,
    }), {
      active: true,
      formattedTime: '1:01:01',
      startedAt: '2026-06-11T12:00:00.000Z',
    });
  });

  it('returns an idle status when the stream is not live', () => {
    assert.deepEqual(getLiveStreamStatus({
      live: false,
      startedAt: '2026-06-11T12:00:00.000Z',
      elapsedSeconds: 3661,
    }), {
      active: false,
      formattedTime: '0:00',
      startedAt: null,
    });
  });
});
