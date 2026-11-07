import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PresentationRenderTokenClaims, RtmpRelayDestination } from '@studio/shared';
import { signLiveStreamToken } from './auth.js';
import { checkRtmpDestinationHosts, isNonPublicAddress } from './rtmpHostPolicy.js';
import { countActiveRelaySessions, getMaxRelaySessions, isRelayCapacityAvailable } from './relayAdmission.js';
import { checkPresentationRenderAdmission } from './presentationAdmission.js';
import { authorizePresentationRender, isPresentationRenderAuthRequired } from './presentationAuth.js';
import {
  DEFAULT_PRESENTATION_PDF_CACHE_MAX_BYTES,
  getPresentationPdfCacheMaxBytes,
  MAX_PRESENTATION_RENDER_BYTES,
  PresentationRenderError,
  PresentationRenderQueue,
} from './presentationRender.js';
import { RecordingUploadError, RecordingUploadStore } from './recordingUpload.js';
import { getRecordingUploadLimits } from './recordingStorageGuard.js';

const SECRET = 'presentation-render-secret-0123456789abcdef';
const MB = 1024 * 1024;

function destination(rtmpUrl: string, name = 'Custom'): RtmpRelayDestination {
  return { id: name.toLowerCase(), name, rtmpUrl, streamKey: 'live_key_123' } as RtmpRelayDestination;
}

describe('RTMP destination host policy', () => {
  it('classifies private, loopback, link-local and CGNAT addresses as non-public', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1',
      '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1',
    ]) {
      assert.equal(isNonPublicAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '142.250.72.14', '100.63.0.1', '172.32.0.1', '2607:f8b0:4005:80a::200e', '::ffff:8.8.8.8']) {
      assert.equal(isNonPublicAddress(address), false, address);
    }
    assert.equal(isNonPublicAddress('not-an-ip'), true);
  });

  it('refuses hosts that resolve inward and accepts public ingest servers', async () => {
    const lookup = async (host: string) => {
      if (host === 'a.rtmp.youtube.com') return [{ address: '142.250.72.14', family: 4 }];
      if (host === 'sneaky.example.com') return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    };
    const env = {};
    assert.equal(await checkRtmpDestinationHosts([destination('rtmp://a.rtmp.youtube.com/live2', 'YouTube')], { env, lookup }), null);
    assert.match(String(await checkRtmpDestinationHosts([destination('rtmp://sneaky.example.com/live')], { env, lookup })), /public internet host/);
    assert.match(String(await checkRtmpDestinationHosts([destination('rtmp://127.0.0.1:1935/live')], { env, lookup })), /public internet host/);
    assert.match(String(await checkRtmpDestinationHosts([destination('rtmp://[::1]/live')], { env, lookup })), /public internet host/);
    assert.match(String(await checkRtmpDestinationHosts([destination('rtmp://localhost/live')], { env, lookup })), /public internet host/);
    assert.match(String(await checkRtmpDestinationHosts([destination('rtmp://missing.example.com/live')], { env, lookup })), /could not be found/);
  });

  it('allows private hosts only with RTMP_ALLOW_PRIVATE_HOSTS=true', async () => {
    const lookup = async () => { throw new Error('lookup must not run'); };
    assert.equal(
      await checkRtmpDestinationHosts([destination('rtmp://127.0.0.1/live')], { env: { RTMP_ALLOW_PRIVATE_HOSTS: 'true' }, lookup }),
      null
    );
  });
});

describe('relay session cap', () => {
  it('defaults to one broadcast and counts each started session once', () => {
    assert.equal(getMaxRelaySessions({}), 1);
    assert.equal(getMaxRelaySessions({ MAX_RELAY_SESSIONS: '3' }), 3);
    assert.equal(getMaxRelaySessions({ MAX_RELAY_SESSIONS: 'zero' }), 1);
    const live = { started: true, stopping: false };
    const stopping = { started: true, stopping: true };
    const idle = { started: false, stopping: false };
    const current = { started: false, stopping: false };
    // A resumed broadcast is registered under two sockets for a moment.
    const registered = [live, live, stopping, idle, current];
    assert.equal(countActiveRelaySessions(registered), 1);
    assert.equal(isRelayCapacityAvailable(registered, current, {}), false);
    assert.equal(isRelayCapacityAvailable(registered, current, { MAX_RELAY_SESSIONS: '2' }), true);
    assert.equal(isRelayCapacityAvailable([idle, current], current, {}), true);
  });
});

describe('presentation renderer protection', () => {
  it('requires a token by default in production only', () => {
    assert.equal(isPresentationRenderAuthRequired({ NODE_ENV: 'production' }), true);
    assert.equal(isPresentationRenderAuthRequired({ NODE_ENV: 'production', PRESENTATION_RENDER_REQUIRE_AUTH: 'false' }), false);
    assert.equal(isPresentationRenderAuthRequired({ NODE_ENV: 'development' }), false);
    assert.equal(isPresentationRenderAuthRequired({ PRESENTATION_RENDER_REQUIRE_AUTH: 'true' }), true);
  });

  it('accepts only an unexpired presentation-render token', () => {
    const now = Date.now();
    const claims: PresentationRenderTokenClaims = {
      v: 1, purpose: 'presentation-render', roomId: 'room-1', participantId: 'host-1', role: 'host', iat: now, exp: now + 60_000, nonce: 'n1',
    };
    assert.equal(authorizePresentationRender(signLiveStreamToken(claims, SECRET), SECRET, now).roomId, 'room-1');

    const liveToken = signLiveStreamToken({ v: 1, roomId: 'room-1', participantId: 'host-1', role: 'host', exp: now + 60_000, nonce: 'n2' }, SECRET);
    const sfuToken = signLiveStreamToken({ v: 1, purpose: 'sfu', roomId: 'room-1', participantId: 'guest-1', role: 'guest', exp: now + 60_000, nonce: 'n3' }, SECRET);
    for (const token of [liveToken, sfuToken, '', 'garbage', signLiveStreamToken({ ...claims, exp: now - 1 }, SECRET), signLiveStreamToken(claims, `${SECRET}x`)]) {
      assert.throws(() => authorizePresentationRender(token, SECRET, now), (error: unknown) => (
        error instanceof PresentationRenderError && error.statusCode === 401
      ));
    }
    assert.throws(() => authorizePresentationRender('x', null, now), (error: unknown) => (
      error instanceof PresentationRenderError && error.statusCode === 503
    ));
  });

  it('defers renders that would leave too little memory beside a live relay', () => {
    const tight = { usedBytes: 330 * MB, limitBytes: 512 * MB };
    assert.throws(() => checkPresentationRenderAdmission({ liveRelayActive: true, memory: tight, env: {} }), (error: unknown) => (
      error instanceof PresentationRenderError && error.statusCode === 503 && error.code === 'PRESENTATION_RENDER_DEFERRED'
    ));
    // The same memory is fine when nothing is live.
    assert.doesNotThrow(() => checkPresentationRenderAdmission({ liveRelayActive: false, memory: tight, env: {} }));
    assert.doesNotThrow(() => checkPresentationRenderAdmission({ liveRelayActive: true, memory: { usedBytes: 200 * MB, limitBytes: 512 * MB }, env: {} }));
    assert.throws(() => checkPresentationRenderAdmission({ liveRelayActive: false, memory: { usedBytes: 450 * MB, limitBytes: 512 * MB }, env: {} }));
    assert.doesNotThrow(() => checkPresentationRenderAdmission({
      liveRelayActive: true, memory: tight, env: { PRESENTATION_RENDER_MEMORY_GUARD: 'false' },
    }));
  });

  it('reserves render slots before bodies are buffered, by count and by bytes', () => {
    const queue = new PresentationRenderQueue(1, 2);
    const first = queue.tryReserve(10 * MB);
    const second = queue.tryReserve(10 * MB);
    const third = queue.tryReserve(10 * MB);
    assert.ok(first && second && third);
    assert.equal(queue.tryReserve(1), null, 'concurrency plus queue is the ceiling');
    first();
    first();
    assert.equal(queue.reservedCount, 2, 'releasing twice frees one slot');
    second();
    third();

    const big = new PresentationRenderQueue(4, 4);
    const a = big.tryReserve(MAX_PRESENTATION_RENDER_BYTES);
    const b = big.tryReserve(MAX_PRESENTATION_RENDER_BYTES);
    assert.ok(a && b);
    assert.equal(big.tryReserve(MAX_PRESENTATION_RENDER_BYTES), null, 'at most two full-size decks are buffered at once');
    assert.equal(big.tryReserve(Number.NaN), null, 'an unknown length counts as a full-size deck');
    a();
    assert.ok(big.tryReserve(Number.NaN));
  });

  it('keeps the PDF cache small by default', () => {
    assert.equal(getPresentationPdfCacheMaxBytes({}), DEFAULT_PRESENTATION_PDF_CACHE_MAX_BYTES);
    assert.ok(DEFAULT_PRESENTATION_PDF_CACHE_MAX_BYTES <= 32 * MB);
    assert.equal(getPresentationPdfCacheMaxBytes({ PRESENTATION_PDF_CACHE_MAX_MB: '8' }), 8 * MB);
    assert.equal(getPresentationPdfCacheMaxBytes({ PRESENTATION_PDF_CACHE_MAX_MB: '0' }), 0);
  });
});

describe('recording upload storage limits', () => {
  const request = (participantId: string, expectedBytes?: number) => ({
    roomId: 'room-limits',
    sessionId: 'session-limits',
    participantId,
    participantName: participantId,
    tracks: [{ id: 'audio', label: 'Audio', kind: 'audio', mimeType: 'audio/webm', ...(expectedBytes !== undefined ? { expectedBytes } : {}) }],
  });

  async function store(limits: Partial<ReturnType<typeof getRecordingUploadLimits>> & { free?: number | null } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'recording-limits-test-'));
    const { free = null, ...rest } = limits;
    return new RecordingUploadStore(root, {
      minFreeBytes: 100,
      totalMaxBytes: 1_000,
      maxOpenSessionsPerParticipant: 2,
      freeBytes: async () => free,
      ...rest,
    });
  }

  it('reads limits from the environment', () => {
    const defaults = getRecordingUploadLimits({});
    assert.equal(defaults.minFreeBytes, 1024 * MB);
    assert.equal(defaults.maxOpenSessionsPerParticipant, 4);
    assert.equal(defaults.maxSessionBytes, undefined);
    const custom = getRecordingUploadLimits({ RECORDING_UPLOAD_MIN_FREE_MB: '0', RECORDING_UPLOAD_TOTAL_MAX_MB: '2048', RECORDING_UPLOADS_PER_PARTICIPANT: '2', RECORDING_UPLOAD_MAX_MB: '512' });
    assert.equal(custom.minFreeBytes, 0);
    assert.equal(custom.totalMaxBytes, 2048 * MB);
    assert.equal(custom.maxOpenSessionsPerParticipant, 2);
    assert.equal(custom.maxSessionBytes, 512 * MB);
  });

  it('limits unfinished upload sessions per participant', async () => {
    const uploads = await store();
    const first = await uploads.createSession(request('guest-1', 4));
    await uploads.createSession(request('guest-1'));
    await assert.rejects(uploads.createSession(request('guest-1')), (error: unknown) => (
      error instanceof RecordingUploadError && error.statusCode === 429 && error.code === 'RECORDING_UPLOAD_SESSION_LIMIT'
    ));
    // Another participant is unaffected, and finishing an upload frees a slot.
    await uploads.createSession(request('guest-2'));
    await uploads.appendChunk({ uploadId: first.uploadId, trackId: 'audio', sequence: 0, final: true, data: Buffer.from('abcd') });
    await uploads.createSession(request('guest-1'));
  });

  it('refuses uploads beyond the shared byte budget or the free-space reserve with 507', async () => {
    const budget = await store({ totalMaxBytes: 6, maxOpenSessionsPerParticipant: 10 });
    const upload = await budget.createSession(request('guest-1'));
    await budget.appendChunk({ uploadId: upload.uploadId, trackId: 'audio', sequence: 0, data: Buffer.from('abcd') });
    await assert.rejects(
      budget.appendChunk({ uploadId: upload.uploadId, trackId: 'audio', sequence: 1, data: Buffer.from('efgh') }),
      (error: unknown) => error instanceof RecordingUploadError && error.statusCode === 507 && error.code === 'RECORDING_STORAGE_FULL'
    );
    assert.equal(budget.getStoredBytes(), 4);

    const disk = await store({ free: 150 });
    await assert.rejects(disk.createSession(request('guest-1', 80)), (error: unknown) => (
      error instanceof RecordingUploadError && error.statusCode === 507
    ));
    const small = await disk.createSession(request('guest-1'));
    await disk.appendChunk({ uploadId: small.uploadId, trackId: 'audio', sequence: 0, data: Buffer.alloc(40) });
    await assert.rejects(
      disk.appendChunk({ uploadId: small.uploadId, trackId: 'audio', sequence: 1, data: Buffer.alloc(60) }),
      (error: unknown) => error instanceof RecordingUploadError && error.statusCode === 507
    );
  });

  it('caps one session at RECORDING_UPLOAD_MAX_MB', async () => {
    const uploads = await store({ maxSessionBytes: 2 * MB, totalMaxBytes: 100 * MB });
    const session = await uploads.createSession({ ...request('guest-1'), maxBytes: 10 * MB });
    assert.equal(session.maxBytes, 2 * MB);
  });
});
