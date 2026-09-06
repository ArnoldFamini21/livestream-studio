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
      paused: false,
      formattedTime: '2:14',
      source: 'mix',
    });
  });

  it('marks the mixed recorder as paused without changing the elapsed display', () => {
    const status = getStudioRecordingStatus({
      mixRecording: true,
      mixPaused: true,
      mixFormattedTime: '4:20',
      localRecording: false,
      localFormattedTime: '0:00',
      sessionStartedAt: null,
      sessionElapsedSeconds: 0,
    });

    assert.deepEqual(status, {
      active: true,
      paused: true,
      formattedTime: '4:20',
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
      paused: false,
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
      paused: false,
      formattedTime: '7:30',
      source: 'local',
    });
  });

  it('marks the local multitrack recorder as paused', () => {
    const status = getStudioRecordingStatus({
      mixRecording: false,
      mixFormattedTime: '0:00',
      localRecording: true,
      localPaused: true,
      localFormattedTime: '8:12',
      sessionStartedAt: null,
      sessionElapsedSeconds: 0,
    });

    assert.deepEqual(status, {
      active: true,
      paused: true,
      formattedTime: '8:12',
      source: 'local',
    });
  });
});

it('shows shared pause state to rejoined operators', () => {
  const status = getStudioRecordingStatus({ mixRecording: false, mixFormattedTime: '0:00', localRecording: false, localFormattedTime: '0:00', sessionStartedAt: '2026-09-06T00:00:00Z', sessionPaused: true, sessionElapsedSeconds: 30 });
  assert.equal(status.paused, true);
  assert.equal(status.source, 'session');
});
