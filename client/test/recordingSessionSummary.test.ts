import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRecordingSessionSummary,
  formatRecordingSummaryBytes,
  formatRecordingSummaryDuration,
} from '../src/utils/recordingSessionSummary.ts';

describe('recording session summary', () => {
  it('formats bounded recording durations', () => {
    assert.equal(formatRecordingSummaryDuration(null), '--:--');
    assert.equal(formatRecordingSummaryDuration(-3), '0:00');
    assert.equal(formatRecordingSummaryDuration(65), '1:05');
    assert.equal(formatRecordingSummaryDuration(3661), '1:01:01');
  });

  it('formats bounded recording storage sizes', () => {
    assert.equal(formatRecordingSummaryBytes(Number.NaN), '0 B');
    assert.equal(formatRecordingSummaryBytes(512), '512 B');
    assert.equal(formatRecordingSummaryBytes(1536), '1.5 KB');
    assert.equal(formatRecordingSummaryBytes(2 * 1024 * 1024), '2.0 MB');
  });

  it('summarizes saved tracks, markers, captions, and storage', () => {
    assert.deepEqual(buildRecordingSessionSummary({
      durationSeconds: 125,
      files: [
        { size: 2 * 1024 * 1024, kind: 'program' },
        { size: 512 * 1024, kind: 'audio' },
        { size: 0, kind: 'screen' },
      ],
      markerCount: 2,
      captionCount: 5,
    }), {
      title: 'Recording saved',
      message: '2:05 captured across 2 tracks. Includes 2 markers and 5 captions.',
      durationLabel: '2:05',
      trackLabel: '2 tracks',
      markerLabel: '2 markers',
      storageLabel: '2.5 MB',
      captionLabel: '5 captions',
      totalBytes: 2621440,
    });
  });

  it('omits sidecar copy when no markers or captions exist', () => {
    const summary = buildRecordingSessionSummary({
      durationSeconds: 60,
      files: [{ size: 1024, kind: 'audio' }],
      markerCount: 0,
    });

    assert.equal(summary.message, '1:00 captured across 1 track.');
    assert.equal(summary.captionLabel, null);
  });
});
