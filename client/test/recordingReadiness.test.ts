import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRecordingReadinessSummary,
  type RecordingReadinessOptions,
} from '../src/utils/recordingReadiness.ts';

const readyOptions: RecordingReadinessOptions = {
  participants: [
    {
      id: 'host',
      name: 'Host',
      status: 'on-stage',
      isLocal: true,
      hasStream: true,
      hasAudio: true,
      hasVideo: true,
    },
    {
      id: 'guest',
      name: 'Guest',
      status: 'on-stage',
      hasStream: true,
      hasAudio: true,
      hasVideo: true,
    },
  ],
  screen: { active: false, hasVideo: false, hasAudio: false },
  mediaRecorderSupported: true,
  persistentStorageSupported: true,
  captionsEnabled: true,
  markerCount: 2,
};

describe('recording readiness summary', () => {
  it('marks a multitrack recording setup ready', () => {
    const summary = buildRecordingReadinessSummary(readyOptions);

    assert.equal(summary.status, 'good');
    assert.equal(summary.canStart, true);
    assert.equal(summary.blockingIssue, null);
    assert.deepEqual(
      summary.expectedTracks.map((track) => [track.label, track.kind]),
      [
        ['Host ISO', 'iso'],
        ['Host audio', 'audio'],
        ['Host camera', 'video'],
        ['Guest ISO', 'iso'],
        ['Guest audio', 'audio'],
        ['Guest camera', 'video'],
      ]
    );
  });

  it('blocks recording when the browser cannot record media', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      mediaRecorderSupported: false,
    });

    assert.equal(summary.status, 'bad');
    assert.equal(summary.canStart, false);
    assert.match(summary.blockingIssue || '', /MediaRecorder/);
  });

  it('blocks recording when no on-stage tracks are available', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      participants: [{
        id: 'host',
        name: 'Host',
        status: 'backstage',
        isLocal: true,
        hasStream: true,
        hasAudio: true,
        hasVideo: true,
      }],
    });

    assert.equal(summary.status, 'bad');
    assert.equal(summary.canStart, false);
    assert.match(summary.blockingIssue || '', /No on-stage/);
  });

  it('excludes backstage and green-room tracks from expected recording tracks', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      participants: [
        readyOptions.participants[0],
        {
          id: 'backstage-guest',
          name: 'Backstage Guest',
          status: 'backstage',
          hasStream: true,
          hasAudio: true,
          hasVideo: true,
        },
        {
          id: 'green-room-guest',
          name: 'Green Room Guest',
          status: 'green-room',
          hasStream: true,
          hasAudio: true,
          hasVideo: true,
        },
      ],
    });

    assert.equal(summary.status, 'good');
    assert.deepEqual(
      summary.expectedTracks.map((track) => track.label),
      ['Host ISO', 'Host audio', 'Host camera']
    );
  });

  it('warns when an on-stage remote stream is not connected', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      participants: [
        readyOptions.participants[0],
        {
          id: 'guest',
          name: 'Guest',
          status: 'on-stage',
          hasStream: false,
          hasAudio: false,
          hasVideo: false,
        },
      ],
    });

    assert.equal(summary.status, 'warning');
    assert.equal(summary.canStart, true);
    assert.match(summary.items.find((item) => item.id === 'isolated-tracks')?.detail || '', /remote stream/);
  });

  it('includes local screen and screen audio tracks', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      screen: { active: true, hasVideo: true, hasAudio: true },
    });

    assert.deepEqual(
      summary.expectedTracks.slice(-2).map((track) => [track.label, track.kind]),
      [
        ['Host screen', 'screen'],
        ['Host screen audio', 'audio'],
      ]
    );
  });

  it('keeps memory-only storage as a non-blocking warning', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      persistentStorageSupported: false,
    });

    assert.equal(summary.status, 'warning');
    assert.equal(summary.canStart, true);
    assert.equal(summary.items.find((item) => item.id === 'storage')?.status, 'warning');
  });
});
