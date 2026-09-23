import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RECORDING_UPLOAD_MAX_BYTES,
  MAX_RECORDING_UPLOAD_CHUNK_BYTES,
  RecordingUploadError,
  RecordingUploadStore,
} from './recordingUpload.js';

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recording-upload-test-'));
  return {
    root,
    store: new RecordingUploadStore(root),
  };
}

const baseRequest = {
  roomId: 'room-123',
  sessionId: 'session-123',
  participantId: 'host-1',
  participantName: 'Host',
  tracks: [
    {
      id: 'program',
      label: 'Program mix',
      kind: 'program',
      mimeType: 'video/webm;codecs=vp9,opus',
      expectedBytes: 12,
      durationMs: 1_000,
      capture: { sourceId: 'program' },
    },
    {
      id: 'host-audio',
      label: 'Host audio',
      kind: 'audio',
      mimeType: 'audio/webm;codecs=opus',
      expectedBytes: 6,
    },
  ],
  maxBytes: 32,
} as const;

describe('recording upload store', () => {
  it('creates a bounded recording upload session without exposing file paths', async () => {
    const { store } = await createStore();

    const session = await store.createSession(baseRequest);

    assert.equal(session.roomId, 'room-123');
    assert.equal(session.sessionId, 'session-123');
    assert.equal(session.participantId, 'host-1');
    assert.equal(session.participantName, 'Host');
    assert.equal(session.maxBytes, 32);
    assert.equal(session.bytesReceived, 0);
    assert.equal(session.tracks.length, 2);
    assert.deepEqual(Object.keys(session.tracks[0]).sort(), [
      'bytesReceived',
      'chunksReceived',
      'complete',
      'id',
      'kind',
      'label',
      'mimeType',
    ]);
    assert.equal(session.tracks[0].mimeType, 'video/webm;codecs=vp9,opus');
  });

  it('defaults and caps session byte limits', async () => {
    const { store } = await createStore();

    const defaultSession = await store.createSession({
      roomId: 'room-default',
      tracks: [{ id: 'audio', label: 'Audio', kind: 'audio', mimeType: 'audio/webm' }],
    });
    const cappedSession = await store.createSession({
      roomId: 'room-capped',
      tracks: [{ id: 'audio', label: 'Audio', kind: 'audio', mimeType: 'audio/webm' }],
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    assert.equal(defaultSession.maxBytes, DEFAULT_RECORDING_UPLOAD_MAX_BYTES);
    assert.ok(cappedSession.maxBytes < Number.MAX_SAFE_INTEGER);
  });

  it('rejects invalid manifests before creating a session', async () => {
    const { store } = await createStore();

    await assert.rejects(
      () => store.createSession({ ...baseRequest, tracks: [] }),
      /At least one recording track/
    );
    await assert.rejects(
      () => store.createSession({
        ...baseRequest,
        tracks: [{ id: 'bad id', label: 'Program', kind: 'program', mimeType: 'video/webm' }],
      }),
      /track id/
    );
    await assert.rejects(
      () => store.createSession({
        ...baseRequest,
        tracks: [{ id: 'program', label: 'Program', kind: 'program', mimeType: 'video/quicktime' }],
      }),
      /must be MP4 or WebM/
    );
    await assert.rejects(
      () => store.createSession({
        ...baseRequest,
        tracks: [
          { id: 'program', label: 'Program', kind: 'program', mimeType: 'video/webm' },
          { id: 'program', label: 'Duplicate', kind: 'video', mimeType: 'video/webm' },
        ],
      }),
      /unique/
    );
  });

  it('accepts MP4 tracks and stores them with MP4 extensions', async () => {
    const { store } = await createStore();
    const session = await store.createSession({
      roomId: 'room-mp4',
      tracks: [
        { id: 'program', label: 'Program', kind: 'program', mimeType: 'video/mp4;codecs=avc1.42e01e,mp4a.40.2' },
        { id: 'host-audio', label: 'Host audio', kind: 'audio', mimeType: 'audio/mp4;codecs=mp4a.40.2' },
      ],
    });
    const state = store.getSession(session.uploadId);
    const [program, hostAudio] = state.tracks.values();

    assert.match(program.filePath, /program\.mp4$/);
    assert.match(hostAudio.filePath, /host-audio\.m4a$/);
    assert.equal(session.tracks[0].mimeType, 'video/mp4;codecs=avc1.42e01e,mp4a.40.2');
    assert.equal(session.tracks[1].mimeType, 'audio/mp4;codecs=mp4a.40.2');
  });

  it('appends ordered chunks and marks a track complete', async () => {
    const { store } = await createStore();
    const session = await store.createSession(baseRequest);

    const first = await store.appendChunk({
      uploadId: session.uploadId,
      trackId: 'program',
      sequence: 0,
      offset: 0,
      data: Buffer.from('hello '),
    });
    const second = await store.appendChunk({
      uploadId: session.uploadId,
      trackId: 'program',
      sequence: 1,
      offset: 6,
      final: true,
      data: Buffer.from('world!'),
    });
    const status = store.getStatus(session.uploadId);
    const state = store.getSession(session.uploadId);
    const stored = await readFile(path.join(state.rootDir, 'program.webm'), 'utf8');

    assert.equal(first.track.bytesReceived, 6);
    assert.equal(second.track.bytesReceived, 12);
    assert.equal(second.track.complete, true);
    assert.equal(status.bytesReceived, 12);
    assert.equal(stored, 'hello world!');
  });

  it('marks tracks complete when the session is explicitly finalized', async () => {
    const { store } = await createStore();
    const session = await store.createSession({
      roomId: 'room-finalize',
      tracks: [{ id: 'program', label: 'Program', kind: 'program', mimeType: 'video/webm' }],
    });
    await store.appendChunk({
      uploadId: session.uploadId,
      trackId: 'program',
      sequence: 0,
      data: Buffer.from('partial'),
    });

    const complete = store.completeSession(session.uploadId);

    assert.equal(complete.tracks[0].complete, true);
    assert.equal(complete.tracks[0].bytesReceived, 7);
  });

  it('rejects out-of-order, mismatched, and oversized chunks', async () => {
    const { store } = await createStore();
    const session = await store.createSession(baseRequest);

    await assert.rejects(
      () => store.appendChunk({
        uploadId: session.uploadId,
        trackId: 'program',
        sequence: 1,
        data: Buffer.from('late'),
      }),
      (err) => err instanceof RecordingUploadError && err.code === 'RECORDING_CHUNK_OUT_OF_ORDER'
    );

    await assert.rejects(
      () => store.appendChunk({
        uploadId: session.uploadId,
        trackId: 'program',
        sequence: 0,
        offset: 3,
        data: Buffer.from('bad'),
      }),
      (err) => err instanceof RecordingUploadError && err.code === 'RECORDING_CHUNK_OFFSET_MISMATCH'
    );

    await assert.rejects(
      () => store.appendChunk({
        uploadId: session.uploadId,
        trackId: 'program',
        sequence: 0,
        data: Buffer.alloc(MAX_RECORDING_UPLOAD_CHUNK_BYTES + 1),
      }),
      (err) => err instanceof RecordingUploadError && err.statusCode === 413
    );
  });

  it('groups completed participant uploads into one distributed export source', async () => {
    const { store } = await createStore();
    const guest = await store.createSession({
      roomId: 'room-group',
      sessionId: 'recording-group-1',
      participantId: 'guest-1',
      participantName: 'Guest One',
      tracks: [{ id: 'guest-iso', label: 'Guest One ISO', kind: 'iso', mimeType: 'video/webm' }],
    });
    await store.appendChunk({
      uploadId: guest.uploadId,
      trackId: 'guest-iso',
      sequence: 0,
      final: true,
      data: Buffer.from('guest-video'),
    });

    const host = await store.createSession({
      roomId: 'room-group',
      sessionId: 'recording-group-1',
      participantId: 'host-1',
      participantName: 'Host program',
      tracks: [{ id: 'program', label: 'Program mix', kind: 'program', mimeType: 'video/webm' }],
    });
    await store.appendChunk({
      uploadId: host.uploadId,
      trackId: 'program',
      sequence: 0,
      final: true,
      data: Buffer.from('program-video'),
    });

    await store.createSession({
      roomId: 'room-group',
      sessionId: 'recording-group-1',
      participantId: 'guest-pending',
      participantName: 'Pending Guest',
      tracks: [{ id: 'pending-iso', label: 'Pending ISO', kind: 'iso', mimeType: 'video/webm' }],
    });

    const summary = store.getDistributedSessionStatus('room-group', 'recording-group-1');
    const source = store.getDistributedExportSource('room-group', 'recording-group-1');

    assert.equal(summary.uploadCount, 3);
    assert.equal(summary.completedUploadCount, 2);
    assert.equal(summary.trackCount, 3);
    assert.equal(source.uploadId, host.uploadId);
    assert.equal(source.tracks.length, 2);
    assert.equal(source.tracks.some((track) => track.kind === 'program'), true);
    assert.equal(source.tracks.some((track) => track.kind === 'iso'), true);
    assert.equal(new Set(source.tracks.map((track) => track.id)).size, 2);
  });

  it('applies final track metadata when a progressive upload completes', async () => {
    const { store } = await createStore();
    const session = await store.createSession({
      roomId: 'room-progressive',
      sessionId: 'recording-progressive-1',
      tracks: [{ id: 'camera', label: 'Camera', kind: 'video', mimeType: 'video/webm' }],
    });
    await store.appendChunk({ uploadId: session.uploadId, trackId: 'camera', sequence: 0, data: Buffer.from('frames') });

    store.completeSession(session.uploadId, Date.now(), {
      tracks: [
        { id: 'camera', durationMs: 61_500, capture: { sourceId: 'local-video', stoppedAt: '2026-09-23T01:00:00.000Z' } },
        { id: 'unknown-track', durationMs: 5 },
      ],
    });
    const source = store.getExportSource(session.uploadId);
    assert.equal(source.tracks[0].durationMs, 61_500);
    assert.equal(source.tracks[0].complete, true);

    assert.throws(
      () => store.completeSession(session.uploadId, Date.now(), { tracks: [{ id: 'camera', durationMs: -1 }] }),
      (err) => err instanceof RecordingUploadError && err.code === 'INVALID_RECORDING_UPLOAD'
    );
  });

  it('exports a participant whose declared screen track never produced media', async () => {
    const { store } = await createStore();
    const guest = await store.createSession({
      roomId: 'room-empty-track',
      sessionId: 'recording-empty-track-1',
      participantId: 'guest-1',
      tracks: [
        { id: 'camera', label: 'Camera', kind: 'video', mimeType: 'video/webm' },
        { id: 'screen', label: 'Screen', kind: 'screen', mimeType: 'video/webm' },
      ],
    });
    await store.appendChunk({ uploadId: guest.uploadId, trackId: 'camera', sequence: 0, data: Buffer.from('camera') });

    assert.equal(store.getDistributedSessionStatus('room-empty-track', 'recording-empty-track-1').completedUploadCount, 0);
    store.completeSession(guest.uploadId);

    const summary = store.getDistributedSessionStatus('room-empty-track', 'recording-empty-track-1');
    assert.equal(summary.completedUploadCount, 1);
    const source = store.getDistributedExportSource('room-empty-track', 'recording-empty-track-1');
    assert.deepEqual(source.tracks.map((track) => track.label), ['Camera']);
  });

  it('does not count a finalized upload with no media as ready', async () => {
    const { store } = await createStore();
    const empty = await store.createSession({
      roomId: 'room-no-media',
      sessionId: 'recording-no-media-1',
      tracks: [{ id: 'camera', label: 'Camera', kind: 'video', mimeType: 'video/webm' }],
    });
    store.completeSession(empty.uploadId);
    assert.equal(store.getDistributedSessionStatus('room-no-media', 'recording-no-media-1').completedUploadCount, 0);
    assert.throws(
      () => store.getDistributedExportSource('room-no-media', 'recording-no-media-1'),
      (err) => err instanceof RecordingUploadError && err.code === 'RECORDING_SESSION_UPLOADS_PENDING'
    );
  });

  it('cleans up session files when an upload is deleted', async () => {
    const { store } = await createStore();
    const session = await store.createSession(baseRequest);
    const state = store.getSession(session.uploadId);
    await store.appendChunk({
      uploadId: session.uploadId,
      trackId: 'host-audio',
      sequence: 0,
      data: Buffer.from('audio'),
    });

    await store.deleteSession(session.uploadId);

    await assert.rejects(() => stat(state.rootDir));
    assert.throws(() => store.getSession(session.uploadId), /not found/);
  });
});
