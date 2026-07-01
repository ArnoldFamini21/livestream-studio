import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRecordingCaptureMetadata,
  finalizeRecordingCaptureMetadata,
  normalizeRecordingCaptureMetadata,
} from '../src/utils/recordingCaptureMetadata.ts';

function createTrack(overrides: Partial<MediaStreamTrack> & { settings?: Record<string, unknown> }): MediaStreamTrack {
  return {
    kind: overrides.kind || 'video',
    label: overrides.label || 'Camera 1',
    readyState: overrides.readyState || 'live',
    enabled: overrides.enabled ?? true,
    muted: overrides.muted ?? false,
    getSettings: () => overrides.settings || {},
  } as unknown as MediaStreamTrack;
}

function createStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

describe('recording capture metadata', () => {
  it('captures non-sensitive track settings for recording manifests', () => {
    const capture = createRecordingCaptureMetadata({
      sourceId: 'host-iso',
      sourceKind: 'iso',
      sourceLabel: 'Host ISO',
      stream: createStream([
        createTrack({
          kind: 'video',
          label: 'FaceTime HD Camera',
          settings: {
            width: 1920,
            height: 1080,
            frameRate: 29.97,
            deviceId: 'private-device-id',
            groupId: 'private-group-id',
          },
        }),
        createTrack({
          kind: 'audio',
          label: 'Studio Mic',
          settings: {
            sampleRate: 48000,
            channelCount: 2,
            echoCancellation: true,
            noiseSuppression: false,
          },
        }),
      ]),
      mimeType: 'video/webm;codecs=vp9,opus',
      requestedBitsPerSecond: 8_500_000,
      startedAt: '2026-06-11T10:00:00.000Z',
    });

    assert.equal(capture.sourceId, 'host-iso');
    assert.equal(capture.trackCount, 2);
    assert.equal(capture.tracks[0].label, 'video track');
    assert.equal(capture.tracks[0].settings.width, 1920);
    assert.equal(capture.tracks[0].settings.frameRate, 29.97);
    assert.equal(capture.tracks[0].label.includes('FaceTime'), false);
    assert.equal('deviceId' in capture.tracks[0].settings, false);
    assert.equal(capture.tracks[1].settings.sampleRate, 48000);
    assert.equal(capture.tracks[1].settings.echoCancellation, true);
  });

  it('finalizes duration and normalizes persisted metadata defensively', () => {
    const capture = finalizeRecordingCaptureMetadata({
      sourceId: 'audio-source',
      sourceKind: 'audio',
      sourceLabel: 'Host audio',
      mimeType: 'audio/webm',
      requestedBitsPerSecond: 256_000,
      startedAt: '2026-06-11T10:00:00.000Z',
      trackCount: 1,
      tracks: [
        {
          kind: 'audio',
          label: 'Mic',
          readyState: 'live',
          enabled: true,
          muted: false,
          settings: { sampleRate: 48000, channelCount: 1 },
        },
      ],
    }, '2026-06-11T10:00:07.250Z');

    assert.equal(capture.durationMs, 7250);
    assert.equal(capture.stoppedAt, '2026-06-11T10:00:07.250Z');

    const normalized = normalizeRecordingCaptureMetadata({
      ...capture,
      sourceId: '',
      tracks: [
        {
          kind: 'audio',
          label: 'Mic',
          readyState: 'ended',
          enabled: false,
          muted: true,
          settings: { sampleRate: 44100, deviceId: 'not persisted' },
        },
      ],
    });

    assert.equal(normalized?.sourceId, 'recording-source');
    assert.equal(normalized?.tracks[0].enabled, false);
    assert.equal(normalized?.tracks[0].muted, true);
    assert.equal(normalized?.tracks[0].settings.sampleRate, 44100);
    assert.equal('deviceId' in normalized!.tracks[0].settings, false);
  });
});
