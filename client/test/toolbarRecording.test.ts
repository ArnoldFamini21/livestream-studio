import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildToolbarRecordingUploadFiles,
  formatRecordingTimestamp,
  getToolbarRecordingFallbackToast,
  getToolbarRecordingAction,
} from '../src/utils/toolbarRecording.ts';
import type { RecordingTrackResult } from '../src/hooks/useRecording.ts';

function makeBlob(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size).fill(1)], { type });
}

describe('toolbar recording file mapping', () => {
  it('preserves program mix kind for media-server final MP4 export', () => {
    const timestamp = formatRecordingTimestamp(new Date('2026-07-04T05:06:07.000Z'));
    const recordings = new Map<string, RecordingTrackResult>([
      ['program-mix', {
        name: 'Program mix',
        kind: 'program',
        blob: makeBlob(8, 'video/webm;codecs=vp9,opus'),
      }],
    ]);

    const files = buildToolbarRecordingUploadFiles(recordings, timestamp);

    assert.equal(timestamp, '2026-07-04-05-06-07');
    assert.equal(files.length, 1);
    assert.equal(files[0].label, 'Program mix');
    assert.equal(files[0].kind, 'program');
    assert.equal(files[0].fileName, 'Program_mix_2026-07-04-05-06-07.webm');
  });

  it('falls back to audio and iso kinds for legacy toolbar tracks', () => {
    const files = buildToolbarRecordingUploadFiles(new Map<string, RecordingTrackResult>([
      ['audio', { name: 'Host mic', blob: makeBlob(8, 'audio/mp4') }],
      ['video', { name: 'Host camera', blob: makeBlob(8, 'video/mp4') }],
      ['empty', { name: 'Empty', kind: 'program', blob: makeBlob(0, 'video/webm') }],
    ]), '2026-07-04-05-06-07');

    assert.deepEqual(files.map((file) => [file.label, file.kind, file.fileName]), [
      ['Host mic', 'audio', 'Host_mic_2026-07-04-05-06-07.m4a'],
      ['Host camera', 'iso', 'Host_camera_2026-07-04-05-06-07.mp4'],
    ]);
  });

  it('summarizes browser-native MP4 fallback files', () => {
    const files = buildToolbarRecordingUploadFiles(new Map<string, RecordingTrackResult>([
      ['program', { name: 'Program mix', kind: 'program', blob: makeBlob(8, 'video/mp4') }],
    ]), '2026-07-04-05-06-07');

    assert.equal(
      getToolbarRecordingFallbackToast(files),
      'Media-server final MP4 mix unavailable. Saved browser-native MP4/M4A recording tracks.'
    );
  });
});

describe('toolbar action after reconnecting', () => {
  it('stops the shared session when no program recorder exists in this tab', () => {
    assert.equal(getToolbarRecordingAction({ mixRecording: false, localRecording: false, sessionStartedAt: '2026-09-06T00:00:00Z' }), 'stop-session');
  });
  it('finishes standalone local tracks rather than starting an overlapping mix', () => {
    assert.equal(getToolbarRecordingAction({ mixRecording: false, localRecording: true, sessionStartedAt: null }), 'stop-local');
  });
  it('exports an existing mix first and starts only when all sources are idle', () => {
    assert.equal(getToolbarRecordingAction({ mixRecording: true, localRecording: true, sessionStartedAt: '2026-09-06T00:00:00Z' }), 'stop-mix');
    assert.equal(getToolbarRecordingAction({ mixRecording: false, localRecording: false, sessionStartedAt: null }), 'start');
  });
});
