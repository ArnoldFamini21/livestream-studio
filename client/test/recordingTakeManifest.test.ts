import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTakeManifest,
  createCaptureTimeline,
  estimateClockOffset,
  getAlignedTrackStartMs,
  getTrackStartOffsetsSeconds,
  pauseCaptureTimeline,
  resumeCaptureTimeline,
  stopCaptureTimeline,
  timelineNow,
  withClockOffset,
} from '../src/utils/recordingTakeManifest.ts';
import { finalizeRecordingCaptureMetadata, normalizeRecordingCaptureMetadata, type RecordingCaptureMetadata } from '../src/utils/recordingCaptureMetadata.ts';

function capture(startMs: number, extra: Partial<RecordingCaptureMetadata> = {}): RecordingCaptureMetadata {
  return {
    sourceId: 'guest-audio',
    sourceKind: 'audio',
    sourceLabel: 'Guest audio',
    mimeType: 'audio/webm',
    requestedBitsPerSecond: 256_000,
    startedAt: new Date(startMs).toISOString(),
    trackCount: 1,
    tracks: [],
    timeline: { startMs, timeOrigin: startMs - 1000, pauses: [], segmentIndex: 0 },
    ...extra,
  };
}

describe('capture timelines', () => {
  it('uses performance.timeOrigin + now() as the wall clock', () => {
    assert.equal(timelineNow({ timeOrigin: 1_000_000, now: () => 250.5 }), 1_000_250.5);
  });

  it('records pause intervals and excludes them from the duration', () => {
    let timeline = createCaptureTimeline(0, 10_000);
    timeline = pauseCaptureTimeline(timeline, 12_000);
    timeline = pauseCaptureTimeline(timeline, 12_500);
    assert.equal(timeline.pauses.length, 1, 'a second pause while paused is ignored');
    timeline = resumeCaptureTimeline(timeline, 15_000);
    timeline = pauseCaptureTimeline(timeline, 18_000);
    timeline = stopCaptureTimeline(timeline, 20_000);
    assert.deepEqual(timeline.pauses, [{ startMs: 12_000, endMs: 15_000 }, { startMs: 18_000, endMs: 20_000 }]);
    const finalized = finalizeRecordingCaptureMetadata({ ...capture(10_000), timeline }, new Date(20_000).toISOString());
    assert.equal(finalized.durationMs, 5_000);
  });

  it('survives normalisation (library and transfer round trips)', () => {
    const normalized = normalizeRecordingCaptureMetadata(JSON.parse(JSON.stringify(withClockOffset(capture(5_000), 1234.5))));
    assert.equal(normalized?.timeline?.startMs, 5_000);
    assert.equal(normalized?.timeline?.clockOffsetMs, 1234.5);
    assert.equal(normalizeRecordingCaptureMetadata({ ...capture(5_000), timeline: { startMs: 'x' } })?.timeline, undefined);
  });
});

describe('clock offset estimation', () => {
  it('estimates the peer clock offset from the fastest round trips', () => {
    // Peer clock is 5 s ahead; one sample suffered 400 ms of queueing.
    const samples = [
      { t0: 0, t1: 5_020, t2: 40 },
      { t0: 1_000, t1: 6_025, t2: 1_050 },
      { t0: 2_000, t1: 7_390, t2: 2_420 },
      { t0: 3_000, t1: 8_015, t2: 3_030 },
    ];
    const estimate = estimateClockOffset(samples);
    assert.ok(estimate);
    assert.ok(Math.abs(estimate.offsetMs - 5_000) <= 1, `offset ${estimate.offsetMs}`);
    assert.equal(estimate.rttMs, 30);
  });

  it('returns null without usable samples', () => {
    assert.equal(estimateClockOffset([{ t0: 10, t1: 5, t2: 5 }]), null);
  });
});

describe('track alignment', () => {
  it('converts guest starts to the host clock and offsets tracks from the earliest one', () => {
    const host = capture(100_000);
    const guest = withClockOffset(capture(105_250), 5_000); // guest clock 5 s ahead => host time 100_250
    assert.equal(getAlignedTrackStartMs(guest), 100_250);
    assert.deepEqual(getTrackStartOffsetsSeconds([{ capture: host }, { capture: guest }, {}]), [0, 0.25, 0]);
  });

  it('falls back to the ISO start time for older captures', () => {
    assert.equal(getAlignedTrackStartMs({ ...capture(0), timeline: undefined, startedAt: '2026-01-01T00:00:01.000Z' }), Date.parse('2026-01-01T00:00:01.000Z'));
    assert.deepEqual(getTrackStartOffsetsSeconds([{}, {}]), [0, 0]);
  });

  it('builds a take manifest with start offsets and pause intervals', () => {
    const guest = withClockOffset({
      ...capture(52_000, { durationMs: 7_000 }),
      timeline: { startMs: 52_000, timeOrigin: 0, pauses: [{ startMs: 55_000, endMs: 56_000 }], segmentIndex: 1, stopMs: 60_000 },
    }, 2_000);
    const manifest = buildTakeManifest({
      takeId: 'recording-1',
      studioName: 'Studio',
      folder: 'Studio/2026-11-05 2130 take',
      startedAtMs: 49_000,
      stoppedAtMs: 61_000,
      pauses: [{ startMs: 50_000 }],
      now: 61_000,
      tracks: [{
        participantName: 'Maria', label: 'Maria audio (part 2)', kind: 'audio', path: 'Studio/x/Maria/a.webm',
        mimeType: 'audio/webm', bytes: 10, origin: 'guest-transfer', status: 'complete', capture: guest,
      }],
    });
    assert.equal(manifest.format, 'livestream-studio-take');
    assert.deepEqual(manifest.pauses, [{ startOffsetMs: 1_000, endOffsetMs: 12_000 }]);
    const [track] = manifest.tracks;
    assert.equal(track.startOffsetMs, 1_000);
    assert.equal(track.segmentIndex, 1);
    assert.equal(track.durationMs, 7_000);
    assert.deepEqual(track.pauses, [{ startOffsetMs: 4_000, endOffsetMs: 5_000 }]);
    assert.equal(track.clockOffsetMs, 2_000);
  });
});
