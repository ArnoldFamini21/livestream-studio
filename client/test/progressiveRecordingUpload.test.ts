import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PROGRESSIVE_UPLOAD_COMPLETION_MAX_BYTES,
  buildProgressiveCompletionBody,
  createProgressiveRecordingUploader,
  getProgressiveUploadPercent,
  isProgressiveUploadMimeType,
  toProgressiveUploadTrackId,
  type ProgressiveUploadState,
  type ProgressiveUploadTrackSource,
} from '../src/utils/progressiveRecordingUpload.ts';

interface FakeTrack {
  id: string;
  data: number[];
  chunks: number;
  complete: boolean;
}

interface FakeSession {
  uploadId: string;
  roomId: string;
  sessionId?: string;
  participantId?: string;
  tracks: Map<string, FakeTrack>;
}

/** Minimal in-memory media server with the same ordering and offset rules as RecordingUploadStore. */
function createFakeMediaServer() {
  const sessions = new Map<string, FakeSession>();
  let nextId = 1;
  const faults = {
    failNext: 0,
    dropNextChunkResponse: false,
    unauthorizedNext: false,
    forbidAll: false,
  };
  const requests: string[] = [];
  const tokensSeen: string[] = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const trackStatus = (track: FakeTrack) => ({
    id: track.id,
    label: track.id,
    kind: 'video',
    mimeType: 'video/webm',
    bytesReceived: track.data.length,
    chunksReceived: track.chunks,
    complete: track.complete,
  });
  const sessionStatus = (session: FakeSession) => ({
    uploadId: session.uploadId,
    roomId: session.roomId,
    sessionId: session.sessionId,
    participantId: session.participantId,
    createdAt: '2026-09-23T00:00:00.000Z',
    expiresAt: '2026-09-23T06:00:00.000Z',
    maxBytes: 1e12,
    bytesReceived: Array.from(session.tracks.values()).reduce((sum, track) => sum + track.data.length, 0),
    tracks: Array.from(session.tracks.values()).map(trackStatus),
  });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}${url.search}`);
    const authorization = new Headers(init?.headers).get('authorization') || '';
    tokensSeen.push(authorization.replace(/^Bearer\s+/i, ''));
    if (faults.forbidAll) return json({ error: 'Forbidden', code: 'ROOM_TOKEN_MISMATCH' }, 403);
    if (faults.unauthorizedNext) {
      faults.unauthorizedNext = false;
      return json({ error: 'Token expired', code: 'UNAUTHORIZED' }, 401);
    }
    if (faults.failNext > 0) {
      faults.failNext -= 1;
      return json({ error: 'Temporarily unavailable' }, 503);
    }

    if (url.pathname === '/recordings/uploads' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const session: FakeSession = {
        uploadId: `upload-${nextId++}`,
        roomId: body.roomId,
        sessionId: body.sessionId,
        participantId: body.participantId,
        tracks: new Map(body.tracks.map((track: { id: string }) => [track.id, { id: track.id, data: [], chunks: 0, complete: false }])),
      };
      sessions.set(session.uploadId, session);
      return json(sessionStatus(session), 201);
    }

    const chunkMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/tracks\/([^/]+)\/chunks$/);
    if (chunkMatch && method === 'POST') {
      const session = sessions.get(decodeURIComponent(chunkMatch[1]));
      if (!session) return json({ error: 'Recording upload session not found', code: 'RECORDING_UPLOAD_NOT_FOUND' }, 404);
      const track = session.tracks.get(decodeURIComponent(chunkMatch[2]));
      if (!track) return json({ error: 'Recording track not found', code: 'RECORDING_TRACK_NOT_FOUND' }, 404);
      const sequence = Number(url.searchParams.get('sequence'));
      const offset = Number(url.searchParams.get('offset'));
      if (sequence !== track.chunks) return json({ error: 'Out of order', code: 'RECORDING_CHUNK_OUT_OF_ORDER' }, 409);
      if (offset !== track.data.length) return json({ error: 'Offset mismatch', code: 'RECORDING_CHUNK_OFFSET_MISMATCH' }, 409);
      const bytes = new Uint8Array(await (init?.body as Blob).arrayBuffer());
      if (bytes.length === 0) return json({ error: 'Empty chunk', code: 'INVALID_RECORDING_CHUNK' }, 400);
      track.data.push(...bytes);
      track.chunks += 1;
      track.complete = url.searchParams.get('final') === '1';
      if (faults.dropNextChunkResponse) {
        faults.dropNextChunkResponse = false;
        throw new TypeError('Network connection lost');
      }
      return json({ uploadId: session.uploadId, track: trackStatus(track), bytesReceived: track.data.length });
    }

    const completeMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/complete$/);
    if (completeMatch && method === 'POST') {
      const session = sessions.get(decodeURIComponent(completeMatch[1]));
      if (!session) return json({ error: 'Recording upload session not found', code: 'RECORDING_UPLOAD_NOT_FOUND' }, 404);
      for (const track of session.tracks.values()) track.complete = true;
      return json(sessionStatus(session));
    }

    const statusMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)$/);
    if (statusMatch && method === 'GET') {
      const session = sessions.get(decodeURIComponent(statusMatch[1]));
      if (!session) return json({ error: 'Recording upload session not found', code: 'RECORDING_UPLOAD_NOT_FOUND' }, 404);
      return json(sessionStatus(session));
    }

    return json({ error: 'Not found' }, 404);
  };

  return {
    fetchImpl,
    faults,
    requests,
    tokensSeen,
    sessions,
    restart() {
      sessions.clear();
    },
    trackBytes(uploadId: string, trackId: string): Uint8Array {
      return Uint8Array.from(sessions.get(uploadId)?.tracks.get(trackId)?.data || []);
    },
  };
}

/** A growing recording whose committed prefix is exposed like the OPFS chunk store. */
function createRecordingSource(id: string, totalBytes: number, kind: ProgressiveUploadTrackSource['kind'] = 'video') {
  const bytes = Uint8Array.from({ length: totalBytes }, (_, index) => (index * 7 + id.length) % 251);
  let committed = 0;
  const source: ProgressiveUploadTrackSource = {
    id,
    label: id,
    kind,
    mimeType: kind === 'audio' ? 'audio/webm' : 'video/webm',
    snapshot: async () => new Blob([bytes.slice(0, committed)], { type: source.mimeType }),
  };
  return {
    source,
    bytes,
    commit(size: number) {
      committed = Math.min(totalBytes, committed + size);
    },
    finalBlob: () => new Blob([bytes], { type: source.mimeType }),
  };
}

function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function createUploader(
  server: ReturnType<typeof createFakeMediaServer>,
  clock = createClock(),
  overrides: Partial<Parameters<typeof createProgressiveRecordingUploader>[0]> = {}
) {
  let tokenCount = 0;
  const sleeps: number[] = [];
  const states: ProgressiveUploadState[] = [];
  const uploader = createProgressiveRecordingUploader({
    mediaHttpUrl: 'https://media.example.test/',
    roomId: 'room-1',
    sessionId: 'recording-session-1',
    participantId: 'guest-1',
    participantName: 'Nica',
    getToken: async () => `token-${++tokenCount}`,
    fetchImpl: server.fetchImpl as typeof fetch,
    autoSchedule: false,
    minChunkBytes: 100,
    maxChunkBytes: 256,
    maxIdleMs: 10_000,
    retryBaseMs: 10,
    maxRetryDelayMs: 40,
    now: clock.now,
    sleep: async (ms) => { sleeps.push(ms); },
    onChange: (state) => states.push(state),
    ...overrides,
  });
  return { uploader, sleeps, states, tokenCount: () => tokenCount };
}

describe('progressive recording upload', () => {
  it('uploads committed bytes during recording and finishes byte-identically', async () => {
    const server = createFakeMediaServer();
    const clock = createClock();
    const video = createRecordingSource('camera', 1_000);
    const audio = createRecordingSource('microphone', 300, 'audio');
    const { uploader, states } = createUploader(server, clock);

    uploader.start([video.source, audio.source]);
    await uploader.flush();
    const uploadId = uploader.getState().uploadId;
    assert.ok(uploadId, 'the session opens when recording starts');
    assert.equal(uploader.getState().uploadedBytes, 0);

    video.commit(600);
    audio.commit(50);
    await uploader.flush();
    assert.equal(
      uploader.getState().tracks.find((track) => track.id === 'camera')?.uploadedBytes,
      512,
      'two full chunks; the 88-byte tail waits for a minimum-size chunk'
    );
    assert.equal(
      uploader.getState().tracks.find((track) => track.id === 'microphone')?.uploadedBytes,
      0,
      'small tails wait for a larger chunk'
    );
    assert.equal(
      server.requests.filter((request) => request.includes('/tracks/camera/chunks')).length,
      2,
      'large ranges are split into bounded chunks'
    );

    clock.advance(10_001);
    await uploader.flush();
    assert.equal(
      uploader.getState().tracks.find((track) => track.id === 'microphone')?.uploadedBytes,
      50,
      'an idle tail is sent after the idle timeout'
    );
    assert.equal(uploader.getState().status, 'uploading');

    const result = await uploader.finish(new Map([
      ['camera', video.finalBlob()],
      ['microphone', audio.finalBlob()],
    ]));
    assert.equal(result.uploadId, uploadId);
    assert.deepEqual(server.trackBytes(uploadId, 'camera'), video.bytes);
    assert.deepEqual(server.trackBytes(uploadId, 'microphone'), audio.bytes);
    assert.ok(result.tracks.every((track) => track.complete));
    assert.equal(uploader.getState().status, 'complete');
    assert.equal(getProgressiveUploadPercent(uploader.getState()), 100);
    assert.ok(states.some((state) => state.status === 'finishing'));

    const created = server.sessions.get(uploadId);
    assert.equal(created?.participantId, 'guest-1');
    assert.equal(created?.sessionId, 'recording-session-1');
  });

  it('reconciles offsets after a lost chunk response without duplicating bytes', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 900);
    const { uploader } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();

    video.commit(500);
    server.faults.dropNextChunkResponse = true;
    await uploader.flush();
    assert.equal(uploader.getState().retrying, true);
    assert.match(uploader.getState().error || '', /Network connection lost/);

    await uploader.flush();
    assert.equal(uploader.getState().retrying, false);
    assert.ok(server.requests.some((request) => request.startsWith('GET /recordings/uploads/')), 'the client asked the server for its offsets');

    const result = await uploader.finish(new Map([['camera', video.finalBlob()]]));
    assert.deepEqual(server.trackBytes(result.uploadId, 'camera'), video.bytes);
  });

  it('refreshes an expired token once and retries the request', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 200);
    const { uploader, tokenCount } = createUploader(server);
    server.faults.unauthorizedNext = true;
    uploader.start([video.source]);
    await uploader.flush();
    assert.ok(uploader.getState().uploadId);
    assert.equal(tokenCount(), 2);
    assert.deepEqual(server.tokensSeen.slice(0, 2), ['token-1', 'token-2']);
  });

  it('proactively refreshes short-lived host tokens', async () => {
    const server = createFakeMediaServer();
    const clock = createClock();
    const video = createRecordingSource('program', 400);
    const { uploader, tokenCount } = createUploader(server, clock, { tokenRefreshMs: 60_000 });
    uploader.start([video.source]);
    await uploader.flush();
    video.commit(200);
    clock.advance(61_000);
    await uploader.flush();
    assert.equal(tokenCount(), 2);
  });

  it('re-sends the recording into a new session after the media server restarts', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 800);
    const { uploader } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();
    const firstUploadId = uploader.getState().uploadId;

    video.commit(400);
    await uploader.flush();
    assert.equal(uploader.getState().uploadedBytes, 400);

    server.restart();
    video.commit(200);
    await uploader.flush();
    assert.equal(uploader.getState().uploadId, null);
    assert.match(uploader.getState().error || '', /restarted/);

    await uploader.flush();
    const secondUploadId = uploader.getState().uploadId;
    assert.ok(secondUploadId);
    assert.notEqual(secondUploadId, firstUploadId);
    assert.equal(uploader.getState().uploadedBytes, 512, 're-sent from byte zero; the short tail waits for more data');

    const result = await uploader.finish(new Map([['camera', video.finalBlob()]]));
    assert.deepEqual(server.trackBytes(result.uploadId, 'camera'), video.bytes);
  });

  it('pauses on host request, resumes, and always secures the take when finishing', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 700);
    const { uploader } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();

    uploader.pause();
    video.commit(500);
    await uploader.flush();
    assert.equal(uploader.getState().status, 'paused');
    assert.equal(uploader.getState().pausedByHost, true);
    assert.equal(uploader.getState().uploadedBytes, 0);

    uploader.resume();
    await uploader.flush();
    assert.equal(uploader.getState().uploadedBytes, 500);

    uploader.pause();
    const result = await uploader.finish(new Map([['camera', video.finalBlob()]]));
    assert.deepEqual(server.trackBytes(result.uploadId, 'camera'), video.bytes);
    assert.equal(uploader.getState().pausedByHost, false);
  });

  it('retries transient failures while finishing with bounded backoff', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 300);
    const { uploader, sleeps } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();

    server.faults.failNext = 3;
    const result = await uploader.finish(new Map([['camera', video.finalBlob()]]));
    assert.deepEqual(server.trackBytes(result.uploadId, 'camera'), video.bytes);
    assert.deepEqual(sleeps, [10, 20, 40]);
  });

  it('fails fast on authorization errors so the caller can fall back', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 300);
    const { uploader, sleeps } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();
    server.faults.forbidAll = true;
    await assert.rejects(uploader.finish(new Map([['camera', video.finalBlob()]])), /Forbidden/);
    assert.equal(uploader.getState().status, 'error');
    assert.deepEqual(sleeps, []);
  });

  it('completes a session when a declared track produced no data', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 250);
    const screen = createRecordingSource('screen', 0, 'screen');
    const { uploader } = createUploader(server);
    uploader.start([video.source, screen.source]);
    await uploader.flush();
    const result = await uploader.finish(new Map([
      ['camera', video.finalBlob()],
      ['screen', new Blob([], { type: 'video/webm' })],
    ]));
    assert.equal(result.tracks.find((track) => track.id === 'screen')?.bytesReceived, 0);
    assert.ok(!server.requests.some((request) => request.includes('/tracks/screen/chunks')));
    assert.deepEqual(server.trackBytes(result.uploadId, 'camera'), video.bytes);
  });

  it('still finishes the take after background work was stopped', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 600);
    const { uploader } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();
    video.commit(300);
    await uploader.flush();
    uploader.stop();
    const result = await uploader.finish(new Map([['camera', video.finalBlob()]]));
    assert.deepEqual(server.trackBytes(result.uploadId, 'camera'), video.bytes);
    assert.equal(uploader.getState().status, 'complete');
  });

  it('stops background work without touching server data', async () => {
    const server = createFakeMediaServer();
    const video = createRecordingSource('camera', 400);
    const { uploader } = createUploader(server);
    uploader.start([video.source]);
    await uploader.flush();
    uploader.stop();
    video.commit(400);
    const before = server.requests.length;
    await uploader.flush();
    assert.equal(server.requests.length, before);
  });
});

describe('progressive upload completion metadata', () => {
  it('sends final durations and capture details, trimming capture when too large', () => {
    const small = JSON.parse(buildProgressiveCompletionBody(
      ['camera', 'microphone'],
      new Map([
        ['camera', { durationMs: 61_500, capture: { sourceId: 'local-video' } }],
        ['microphone', { durationMs: -5 }],
        ['unknown', { durationMs: 1 }],
      ])
    ));
    assert.deepEqual(small, {
      tracks: [
        { id: 'camera', durationMs: 61_500, capture: { sourceId: 'local-video' } },
        { id: 'microphone' },
      ],
    });

    const large = JSON.parse(buildProgressiveCompletionBody(
      ['camera'],
      new Map([['camera', { durationMs: 1_000, capture: { notes: 'x'.repeat(PROGRESSIVE_UPLOAD_COMPLETION_MAX_BYTES) } }]])
    ));
    assert.deepEqual(large, { tracks: [{ id: 'camera', durationMs: 1_000 }] });
    assert.equal(buildProgressiveCompletionBody(['camera'], undefined), '{}');
  });
});

describe('progressive upload helpers', () => {
  it('creates stable, unique, media-server-safe track ids', () => {
    const seen = new Set<string>();
    assert.equal(toProgressiveUploadTrackId('local-video', 0, seen), 'local-video');
    assert.equal(toProgressiveUploadTrackId('local video', 1, seen), 'local-video-2');
    assert.equal(toProgressiveUploadTrackId('???', 2, seen), 'track-3');
  });

  it('accepts only containers the media server stores', () => {
    assert.equal(isProgressiveUploadMimeType('video/webm;codecs=vp9,opus'), true);
    assert.equal(isProgressiveUploadMimeType('audio/webm'), true);
    assert.equal(isProgressiveUploadMimeType('video/mp4; codecs="avc1.42E01E"'), true);
    assert.equal(isProgressiveUploadMimeType('audio/ogg;codecs=opus'), false);
    assert.equal(isProgressiveUploadMimeType(''), false);
  });

  it('reports whole-number progress and reserves 100% for completion', () => {
    assert.equal(getProgressiveUploadPercent({ status: 'uploading', recordedBytes: 0, uploadedBytes: 0 }), 0);
    assert.equal(getProgressiveUploadPercent({ status: 'uploading', recordedBytes: 1000, uploadedBytes: 505 }), 50);
    assert.equal(getProgressiveUploadPercent({ status: 'finishing', recordedBytes: 1000, uploadedBytes: 1000 }), 99);
    assert.equal(getProgressiveUploadPercent({ status: 'complete', recordedBytes: 1000, uploadedBytes: 1000 }), 100);
  });
});
