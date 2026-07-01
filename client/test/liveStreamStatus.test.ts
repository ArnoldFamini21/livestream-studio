import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLiveSessionSummary,
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

  it('builds a clean post-live summary from start and stop timestamps', () => {
    assert.deepEqual(buildLiveSessionSummary({
      startedAt: '2026-06-11T12:00:00.000Z',
      stoppedAt: '2026-06-11T12:12:30.000Z',
      destinationCount: 2,
    }), {
      title: 'Stream ended',
      message: 'Stream ran for 12:30. 2 destinations finished cleanly.',
      tone: 'success',
      formattedDuration: '12:30',
      destinationLabel: '2 destinations',
    });
  });

  it('builds a warning summary when destinations report errors', () => {
    assert.deepEqual(buildLiveSessionSummary({
      startedAt: '2026-06-11T12:00:00.000Z',
      stoppedAt: '2026-06-11T12:00:45.000Z',
      destinationCount: 3,
      errorCount: 9,
    }), {
      title: 'Stream ended with issues',
      message: 'Stream ran for 0:45. 3/3 destinations reported an error.',
      tone: 'warning',
      formattedDuration: '0:45',
      destinationLabel: '3 destinations',
    });
  });

  it('bounds invalid destination counts in post-live summaries', () => {
    const summary = buildLiveSessionSummary({
      startedAt: null,
      stoppedAt: 'not-a-date',
      destinationCount: Number.NaN,
      errorCount: Number.NaN,
    });

    assert.equal(summary.destinationLabel, '0 destinations');
    assert.equal(summary.message, 'Stream ran for 0:00. No destinations were enabled.');
  });
});
