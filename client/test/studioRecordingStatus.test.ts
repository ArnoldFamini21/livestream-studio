import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatStudioRecordingDuration,
  getStudioRecordingStatus,
} from '../src/utils/studioRecordingStatus.ts';

describe('studio recording status', () => {
  it('formats elapsed recording time for header badges', () => {
    assert.equal(formatStudioRecordingDuration(0), '0:00');
    assert.equal(formatStudioRecordingDuration(65), '1:05');
    assert.equal(formatStudioRecordingDuration(3661), '1:01:01');
    assert.equal(formatStudioRecordingDuration(-20), '0:00');
  });

  it('prefers the active mixed recorder timer when present', () => {
    const status = getStudioRecordingStatus({
      mixRecording: true,
      mixFormattedTime: '2:14',
      localRecording: true,
      localFormattedTime: '5:00',
      sessionStartedAt: '2026-06-11T12:00:00.000Z',
      sessionElapsedSeconds: 180,
    });

    assert.deepEqual(status, {
      active: true,
      formattedTime: '2:14',
      source: 'mix',
    });
  });

  it('uses shared session recording state when another operator has recording active', () => {
    const status = getStudioRecordingStatus({
      mixRecording: false,
      mixFormattedTime: '0:00',
      localRecording: false,
      localFormattedTime: '0:00',
      sessionStartedAt: '2026-06-11T12:00:00.000Z',
      sessionElapsedSeconds: 125,
    });

    assert.deepEqual(status, {
      active: true,
      formattedTime: '2:05',
      source: 'session',
    });
  });

  it('falls back to the local multitrack recorder timer', () => {
    const status = getStudioRecordingStatus({
      mixRecording: false,
      mixFormattedTime: '0:00',
      localRecording: true,
      localFormattedTime: '7:30',
      sessionStartedAt: null,
      sessionElapsedSeconds: 0,
    });

    assert.deepEqual(status, {
      active: true,
      formattedTime: '7:30',
      source: 'local',
    });
  });
});
