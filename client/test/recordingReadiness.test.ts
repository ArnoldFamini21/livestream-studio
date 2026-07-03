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
      summary.expectedTracks.slice(-3).map((track) => [track.label, track.kind]),
      [
        ['Host screen', 'screen'],
        ['Host screen PiP', 'screen'],
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

  it('includes a ready encoder check when browser encoding readiness is available', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      encodingReadiness: {
        status: 'ready',
        detail: '1080p/30 browser recording is advertised as smooth and power efficient.',
      },
    });

    assert.equal(summary.status, 'good');
    assert.equal(summary.canStart, true);
    assert.deepEqual(summary.items.find((item) => item.id === 'encoding-quality'), {
      id: 'encoding-quality',
      label: 'Encoding quality',
      status: 'good',
      detail: '1080p/30 browser recording is advertised as smooth and power efficient.',
      blocksStart: false,
    });
  });

  it('warns without blocking when the browser encoder is limited', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      encodingReadiness: {
        status: 'limited',
        detail: 'Use 720p for the most reliable recording and live relay on this browser.',
      },
    });

    assert.equal(summary.status, 'warning');
    assert.equal(summary.canStart, true);
    assert.equal(summary.blockingIssue, null);
    assert.equal(summary.items.find((item) => item.id === 'encoding-quality')?.status, 'warning');
  });

  it('reports hardware WebCodecs pipeline availability without replacing playable MediaRecorder output', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      encodingReadiness: {
        status: 'ready',
        detail: '1080p/30 browser recording is smooth with WebCodecs hardware acceleration.',
        apiSupport: { webCodecs: true },
        presets: [
          {
            presetId: '1080p',
            label: '1080p',
            hardwareAccelerated: true,
            supported: true,
            smooth: true,
          },
        ],
      },
    });

    const item = summary.items.find((item) => item.id === 'webcodecs-pipeline');
    assert.equal(summary.status, 'good');
    assert.equal(item?.status, 'good');
    assert.match(item?.detail || '', /Hardware VideoEncoder/);
    assert.match(item?.detail || '', /MP4\/WebM/);
    assert.match(item?.detail || '', /MediaRecorder/);
  });

  it('keeps WebCodecs absence as a non-blocking recording pipeline warning', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      encodingReadiness: {
        status: 'ready',
        detail: '1080p/30 browser recording is advertised as smooth.',
        apiSupport: { webCodecs: false },
      },
    });

    const item = summary.items.find((item) => item.id === 'webcodecs-pipeline');
    assert.equal(summary.status, 'warning');
    assert.equal(summary.canStart, true);
    assert.equal(item?.status, 'warning');
    assert.match(item?.detail || '', /MediaRecorder container pipeline/);
  });

  it('blocks recording when browser encoding is unsupported', () => {
    const summary = buildRecordingReadinessSummary({
      ...readyOptions,
      encodingReadiness: {
        status: 'unsupported',
        detail: 'This browser cannot record local media chunks.',
      },
    });

    assert.equal(summary.status, 'bad');
    assert.equal(summary.canStart, false);
    assert.equal(summary.blockingIssue, 'This browser cannot record local media chunks.');
    assert.equal(summary.items.find((item) => item.id === 'encoding-quality')?.blocksStart, true);
  });
});
