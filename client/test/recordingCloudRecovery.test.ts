import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { RecordingRecoveryGrant, RecordingRecoveryTrack } from '@studio/shared';
import { finalizeRecoverySource, uploadRecoveredTake } from '../src/utils/recordingCloudRecovery.ts';
import { createWavHeader, parseWavHeader, WAV_HEADER_BYTES } from '../src/utils/wavStream.ts';

const grant: RecordingRecoveryGrant = {
  roomId: 'room-a', takeId: 'recording-a', participantId: 'guest-a', token: 'local-test-offline-grant', expiresAt: '2099-01-01T00:00:00.000Z',
};
const source = { id: 'take-a', label: 'Guest camera', kind: 'iso', blob: new Blob(['abcdef'], { type: 'video/webm' }) };
const saved: RecordingRecoveryTrack = {
  trackId: source.id, participantId: grant.participantId, participantName: 'Guest', label: source.label,
  kind: source.kind, mimeType: source.blob.type, receivedBytes: 3, nextSequence: 1, status: 'uploading',
};

test('retries exactly the missing bytes and their digest after a lost durable receipt', async () => {
  const observed: string[] = [];
  const client: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${grant.token}`);
    if (url.pathname.endsWith('/upload')) return Response.json({ tracks: [saved] });
    if (url.pathname.endsWith('/chunks')) {
      assert.equal(url.searchParams.get('offset'), '3');
      assert.equal(url.searchParams.get('sequence'), '1');
      assert.equal(url.searchParams.get('sha256'), createHash('sha256').update('def').digest('hex'));
      observed.push(await (init?.body as Blob).text());
      if (observed.length === 1) throw new TypeError('The response was lost');
      return Response.json({ ...saved, receivedBytes: 6, nextSequence: 2 });
    }
    assert.ok(url.pathname.endsWith('/complete'));
    assert.deepEqual(JSON.parse(String(init?.body)), { totalBytes: 6, chunkCount: 2 });
    return Response.json({ ...saved, receivedBytes: 6, nextSequence: 2, status: 'verified', totalBytes: 6 });
  };
  await uploadRecoveredTake(grant, [source], { fetchImpl: client });
  assert.deepEqual(observed, ['def', 'def']);
});

test('rejects a conflicting committed chunk without clearing local data or finalizing', async () => {
  const calls: string[] = [];
  const client: typeof fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    calls.push(pathname);
    return pathname.endsWith('/upload') ? Response.json({ tracks: [saved] }) : new Response(null, { status: 409 });
  };
  await assert.rejects(uploadRecoveredTake(grant, [source], { fetchImpl: client }), /no longer match/);
  assert.equal(calls.length, 2);
  assert.equal(await source.blob.text(), 'abcdef');
});

test('the recovered PCM WAV uses the same finalized container header on every retry', async () => {
  const header = createWavHeader({ sampleRate: 48_000, channels: 1, bitsPerSample: 16 });
  const payload = new Uint8Array([2, 3, 5, 7]);
  const unfinished = new Blob([header, payload], { type: 'audio/wav' });
  const verified = await finalizeRecoverySource(unfinished);
  const bytes = new Uint8Array(await verified.arrayBuffer());
  assert.equal(parseWavHeader(bytes)?.dataBytes, payload.length);
  assert.deepEqual(bytes.slice(WAV_HEADER_BYTES), payload);
  assert.deepEqual(new Uint8Array(await (await finalizeRecoverySource(unfinished)).arrayBuffer()), bytes);
});
