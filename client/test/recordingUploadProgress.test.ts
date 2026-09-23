import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeRecordingUploadProgress,
  formatUploadBytes,
  hasUnfinishedRecordingUpload,
  toRecordingUploadProgressPayload,
} from '../src/utils/recordingUploadProgress.ts';
import type { ProgressiveUploadState } from '../src/utils/progressiveRecordingUpload.ts';

const MB = 1024 * 1024;

function state(overrides: Partial<ProgressiveUploadState> = {}): ProgressiveUploadState {
  return {
    status: 'uploading',
    uploadId: 'upload-1',
    recordedBytes: 200 * MB,
    uploadedBytes: 150 * MB,
    tracks: [
      { id: 'camera', label: 'Camera', kind: 'video', recordedBytes: 180 * MB, uploadedBytes: 140 * MB, complete: false },
      { id: 'microphone', label: 'Microphone', kind: 'audio', recordedBytes: 20 * MB, uploadedBytes: 10 * MB, complete: true },
    ],
    pausedByHost: false,
    retrying: false,
    ...overrides,
  };
}

describe('recording upload progress', () => {
  it('formats byte counts for compact status lines', () => {
    assert.equal(formatUploadBytes(0), '0 MB');
    assert.equal(formatUploadBytes(2.5 * MB), '2.5 MB');
    assert.equal(formatUploadBytes(512 * MB), '512 MB');
    assert.equal(formatUploadBytes(3.25 * 1024 * MB), '3.3 GB');
  });

  it('summarizes each upload state for hosts', () => {
    assert.deepEqual(
      describeRecordingUploadProgress({ status: 'uploading', recordedBytes: 200 * MB, uploadedBytes: 150 * MB }),
      { label: 'Uploading · 75%', detail: '150 MB of 200 MB', tone: 'active', percent: 75 }
    );
    assert.equal(
      describeRecordingUploadProgress({ status: 'uploading', recordedBytes: 10, uploadedBytes: 5, message: 'Network lost' }).tone,
      'warning'
    );
    assert.equal(describeRecordingUploadProgress({ status: 'paused', recordedBytes: 10, uploadedBytes: 5 }).label, 'Upload paused · 50%');
    assert.equal(describeRecordingUploadProgress({ status: 'complete', recordedBytes: 10, uploadedBytes: 10 }).percent, 100);
    assert.match(describeRecordingUploadProgress({ status: 'error', recordedBytes: 10, uploadedBytes: 5 }).detail, /saved on their device/);
  });

  it('builds the signaling report from uploader state', () => {
    assert.deepEqual(toRecordingUploadProgressPayload('recording-1', state()), {
      sessionId: 'recording-1',
      status: 'uploading',
      recordedBytes: 200 * MB,
      uploadedBytes: 150 * MB,
      trackCount: 2,
      completedTrackCount: 1,
    });
    assert.equal(toRecordingUploadProgressPayload('recording-1', state({ status: 'starting' }))?.status, 'uploading');
    assert.equal(toRecordingUploadProgressPayload('recording-1', state({ status: 'idle' })), null);
    assert.equal(
      toRecordingUploadProgressPayload('recording-1', state({ retrying: true, error: 'Network lost' }))?.message,
      'Network lost'
    );
  });

  it('guards exits until the take is safely uploaded', () => {
    assert.equal(hasUnfinishedRecordingUpload(null), false);
    assert.equal(hasUnfinishedRecordingUpload(state()), true);
    assert.equal(hasUnfinishedRecordingUpload(state({ status: 'finishing' })), true);
    assert.equal(hasUnfinishedRecordingUpload(state({ status: 'complete' })), false);
    assert.equal(hasUnfinishedRecordingUpload(state({ status: 'error' })), false);
  });
});
