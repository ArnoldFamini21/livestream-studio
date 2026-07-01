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
  it('creates a bounded WebM upload session without exposing file paths', async () => {
    const { store } = await createStore();

    const session = await store.createSession(baseRequest);

    assert.equal(session.roomId, 'room-123');
    assert.equal(session.sessionId, 'session-123');
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
        tracks: [{ id: 'program', label: 'Program', kind: 'program', mimeType: 'video/mp4' }],
      }),
      /must be WebM/
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
