import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Participant } from '@studio/shared';
import { buildTakeChecklist, expectedGuestTracks, openGuestTrackSink, readStudioTakes } from '../src/utils/recordingTakeChecklist.ts';
import { openTakeFolder, TAKE_MANIFEST_FILE_NAME } from '../src/utils/recordingTakeFolder.ts';
import { buildTakeManifest, type ExpectedTakeTrack } from '../src/utils/recordingTakeManifest.ts';
import type { TransferTrackAnnouncement } from '../src/utils/recordingTransferProtocol.ts';
import type { ReceivedTrackEntry } from '../src/utils/recordingTransferSession.ts';
import { MemoryDirectoryHandle } from './memoryDirectory.ts';

const capture = {
  id: 'take-76af3ef1', lane: 0, sessionId: 'recording-1', label: 'Maria ISO',
  kind: 'iso', mimeType: 'video/webm', available: 512,
} satisfies TransferTrackAnnouncement;
const planned: ExpectedTakeTrack[] = [
  { origin: 'program', participantName: 'Program', label: 'Program mix', kind: 'program' },
  { origin: 'guest-transfer', participantId: 'guest-1', participantName: 'Maria', label: 'Maria ISO', kind: 'iso' },
  { origin: 'guest-transfer', participantId: 'guest-1', participantName: 'Maria', label: 'Maria audio', kind: 'audio' },
];

test('a take includes planned, never-announced tracks, and isolates guest and recording identities', async () => {
  const root = new MemoryDirectoryHandle('SSD');
  const startedAt = new Date(2026, 10, 23, 10);
  const folder = await openTakeFolder(root, { studioName: 'Studio', startedAt });
  const manifest = buildTakeManifest({
    takeId: capture.sessionId, studioName: 'Studio', roomId: 'room-1', folder: folder.path, startedAtMs: startedAt.getTime(),
    expectedTracks: planned, tracks: [],
  });
  await folder.writeJson(TAKE_MANIFEST_FILE_NAME, manifest);

  const partial: ReceivedTrackEntry = {
    participantId: 'guest-1', participantName: 'Maria', id: capture.id, announcement: capture, status: 'receiving',
    received: 16, available: 512, sink: Promise.resolve(await openGuestTrackSink(folder, 'guest-1', 'Maria', capture)),
    writes: Promise.resolve(),
  };
  const unrelated = { ...partial, announcement: { ...partial.announcement, sessionId: 'elsewhere' } };
  const before = buildTakeChecklist(manifest, [partial, unrelated], true, new Set(['guest-1']));
  assert.deepEqual(before.rows.map(row => [row.label, row.state]), [
    ['Maria ISO', 'transferring'], ['Program mix', 'recording'], ['Maria audio', 'recording'],
  ]);

  assert.deepEqual(await readStudioTakes(root, 'Studio', 'different-room'), [], 'same-named studios cannot see one another');
  const stored = await readStudioTakes(root, 'Studio', 'room-1', capture.sessionId);
  assert.equal(stored.length, 1);
  assert.deepEqual(buildTakeChecklist(stored[0].manifest, [], false, new Set()).rows.map(row => row.state), [
    'missing', 'missing', 'missing',
  ]);
});

test('guest expectations use stage role, media switches and screen-sharing state', () => {
  const seat = (fields: Partial<Participant>) => ({
    id: 'guest-1', name: 'Maria', role: 'guest', status: 'on-stage', audioEnabled: true, videoEnabled: true,
    screenSharing: true, ...fields,
  }) as Participant;
  assert.deepEqual(expectedGuestTracks([
    seat({}), seat({ id: 'guest-2', status: 'green-room' }), seat({ id: 'operator', role: 'co-host' }),
    seat({ id: 'audio-seat', name: 'No camera', videoEnabled: false, screenSharing: false }),
  ]).map(row => [row.participantId, row.kind]), [
    ['guest-1', 'iso'], ['guest-1', 'audio'], ['guest-1', 'screen'], ['audio-seat', 'audio'],
  ]);
});

test('restores only durable guest bytes after host reload and confirms completed files without resending', async () => {
  const root = new MemoryDirectoryHandle('SSD');
  const startedAt = new Date(2026, 10, 23, 10);
  const source = Uint8Array.from({ length: 5 * 1024 * 1024 + 1 }, (_, index) => index % 251);
  const prefixSize = 4 * 1024 * 1024;
  const prior = await openTakeFolder(root, { studioName: 'Studio', startedAt });
  await prior.writeJson(TAKE_MANIFEST_FILE_NAME, buildTakeManifest({
    takeId: capture.sessionId, studioName: 'Studio', roomId: 'room-1', folder: prior.path, startedAtMs: startedAt.getTime(),
    expectedTracks: planned, tracks: [],
  }));

  const first = await openGuestTrackSink(prior, 'guest-1', 'Maria', { ...capture, available: source.length });
  await first.write(source.subarray(0, prefixSize));
  await first.write(source.subarray(prefixSize, prefixSize + 2));
  assert.equal(first.accepted(), prefixSize + 2, 'the in-page receiver also knows its buffered tail');

  const [{ folder }] = await readStudioTakes(root, 'Studio', 'room-1', capture.sessionId);
  await folder.reserveExistingParticipants();
  const finishedTrack = { ...capture, available: source.length, totalBytes: source.length };
  const resumed = await openGuestTrackSink(folder, 'guest-1', 'Maria', finishedTrack);
  assert.equal(resumed.accepted(), prefixSize, 'only committed parts survive the old page');
  await resumed.write(source.subarray(prefixSize));
  const saved = await resumed.finish({ totalBytes: source.length });
  assert.ok(saved.file);
  assert.equal(Buffer.compare(Buffer.from(await saved.file.arrayBuffer()), source), 0);

  const rejoined = await openGuestTrackSink(folder, 'guest-1', 'Maria', finishedTrack);
  assert.equal(rejoined.savedFile?.path, saved.path);
  assert.equal((await rejoined.finish({ totalBytes: source.length })).bytes, source.length);
  await assert.rejects(rejoined.write(new Uint8Array(1)), /already on the host drive/);
  const after = buildTakeChecklist(buildTakeManifest({
    takeId: capture.sessionId, studioName: 'Studio', roomId: 'room-1', folder: prior.path, startedAtMs: startedAt.getTime(),
    expectedTracks: planned, tracks: [{
      ...planned[1], trackId: capture.id, status: 'complete', mimeType: capture.mimeType, bytes: saved.bytes, path: saved.path,
    }],
  }), [], false, new Set());
  assert.deepEqual(after.rows.map(row => [row.label, row.state]), [
    ['Maria ISO', 'verified'], ['Program mix', 'missing'], ['Maria audio', 'missing'],
  ]);
});
