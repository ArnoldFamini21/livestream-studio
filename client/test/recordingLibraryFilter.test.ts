import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalRecordingSession } from '../src/hooks/useRecordingLibrary.ts';
import { filterRecordingLibrarySessions } from '../src/components/RecordingPanel.tsx';

const sessions: LocalRecordingSession[] = [
  {
    id: 'recording-1',
    roomName: 'Weekly Launch Show',
    createdAt: '2026-06-01T12:00:00.000Z',
    durationSeconds: 1800,
    trackCount: 3,
    totalBytes: 1024,
    files: [
      {
        id: 'recording-1-track-1',
        label: 'Host audio',
        fileName: 'weekly_launch_host_audio.webm',
        size: 256,
        type: 'audio/webm',
        kind: 'audio',
      },
      {
        id: 'recording-1-track-2',
        label: 'Host camera',
        fileName: 'weekly_launch_host_camera.webm',
        size: 512,
        type: 'video/webm',
        kind: 'video',
      },
      {
        id: 'recording-1-track-3',
        label: 'Deck screen',
        fileName: 'weekly_launch_deck_screen.webm',
        size: 256,
        type: 'video/webm',
        kind: 'screen',
      },
    ],
    markers: [
      {
        id: 'marker-1',
        label: 'Product demo',
        seconds: 420,
        createdAt: '2026-06-01T12:07:00.000Z',
      },
    ],
  },
  {
    id: 'recording-2',
    roomName: 'Podcast Interview',
    createdAt: '2026-06-02T15:00:00.000Z',
    durationSeconds: 2400,
    trackCount: 1,
    totalBytes: 512,
    files: [
      {
        id: 'recording-2-track-1',
        label: 'Guest audio',
        fileName: 'podcast_guest_audio.webm',
        size: 512,
        type: 'audio/webm',
        kind: 'audio',
      },
    ],
    markers: [],
  },
  {
    id: 'recording-3',
    roomName: 'Design Review',
    createdAt: '2026-06-03T09:00:00.000Z',
    durationSeconds: 900,
    trackCount: 1,
    totalBytes: 768,
    files: [
      {
        id: 'recording-3-track-1',
        label: 'Figma screen share',
        fileName: 'design_review_screen.webm',
        size: 768,
        type: 'video/webm',
        kind: 'screen',
      },
    ],
  },
];

describe('recording library filters', () => {
  it('searches room names, file labels, file names, and marker labels', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'launch demo', 'all').map((session) => session.id),
      ['recording-1']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'guest audio', 'all').map((session) => session.id),
      ['recording-2']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'figma', 'all').map((session) => session.id),
      ['recording-3']
    );
  });

  it('filters sessions by recorded track kind', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'audio').map((session) => session.id),
      ['recording-1', 'recording-2']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'video').map((session) => session.id),
      ['recording-1']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'screen').map((session) => session.id),
      ['recording-1', 'recording-3']
    );
  });

  it('filters sessions with recording markers', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'markers').map((session) => session.id),
      ['recording-1']
    );
  });
});
