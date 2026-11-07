import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatTakeFolderName, openTakeFolder, recordingPathSegment, TAKE_MANIFEST_FILE_NAME } from '../src/utils/recordingTakeFolder.ts';
import { createFolderRecordingTrackStoreFactory, getTrackFileName, type RecordingTrackStore, type RecordingTrackStoreFactory } from '../src/utils/recordingTrackStore.ts';
import { MemoryDirectoryHandle, blobText } from './memoryDirectory.ts';

const startedAt = new Date(2026, 10, 5, 21, 30);

describe('take folder layout', () => {
  it('names folders by studio, local date/time and participant with unicode-safe names', async () => {
    assert.equal(formatTakeFolderName(startedAt), '2026-11-05 2130 take');
    assert.equal(recordingPathSegment('José / Niño: 王', 'Participant'), 'José _ Niño_ 王');
    assert.equal(getTrackFileName('María audio', 'audio/webm'), 'María audio.webm');

    const root = new MemoryDirectoryHandle('SSD');
    const take = await openTakeFolder(root, { studioName: 'Café Live', startedAt });
    assert.equal(take.path, 'Café Live/2026-11-05 2130 take');
    const writer = await take.createTrackWriter('María', 'María audio.webm');
    assert.equal(writer.path, 'Café Live/2026-11-05 2130 take/María/María audio.webm');
    const second = await take.createTrackWriter('María', 'María audio.webm');
    assert.equal(second.fileName, 'María audio 2.webm', 'a name already in use is never overwritten');
  });

  it('gives two participants with the same name separate folders', async () => {
    const root = new MemoryDirectoryHandle('SSD');
    const take = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    // The host's own tracks already use the "Arnold" folder.
    await take.createTrackWriter('Arnold', 'Arnold audio.webm');
    assert.equal(take.participantFolder('guest-1', 'Maria'), 'Maria');
    assert.equal(take.participantFolder('guest-2', 'maria'), 'maria (2)', 'names differing only in case would share a folder on macOS');
    assert.equal(take.participantFolder('guest-1', 'Maria'), 'Maria', 'one participant keeps one folder');
    assert.equal(take.participantFolder('guest-3', 'Arnold'), 'Arnold (2)', 'a guest named like the host gets its own folder');
    const first = await take.createTrackWriter(take.participantFolder('guest-1', 'Maria'), 'mic.webm');
    const second = await take.createTrackWriter(take.participantFolder('guest-2', 'maria'), 'mic.webm');
    assert.equal(first.path, 'Studio/2026-11-05 2130 take/Maria/mic.webm');
    assert.equal(second.path, 'Studio/2026-11-05 2130 take/maria (2)/mic.webm');
  });

  it('never mixes a new take into an earlier take folder from the same minute', async () => {
    const root = new MemoryDirectoryHandle('SSD');
    const first = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    const writer = await first.createTrackWriter('Host', 'Host audio.webm');
    await writer.append(new Blob(['abc']));
    await writer.finish();
    const second = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    assert.equal(second.takeName, '2026-11-05 2130 take 2');
  });

  it('commits small part files while recording and stitches them on finish', async () => {
    const root = new MemoryDirectoryHandle('SSD');
    const take = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    let clock = 0;
    const writer = await take.createTrackWriter('Host', 'Host ISO.webm', { partBytes: 64 * 1024, partMs: 1_000, now: () => clock });
    await writer.append(new Blob(['header-']));
    clock = 1_500;
    await writer.append(new Blob(['frames-1-']));
    assert.equal(writer.committedBytes(), 16, 'a part is closed after partMs so a crash loses little');
    assert.ok(root.list().some((path) => path.endsWith('Host ISO.webm.parts/000001.part')));
    await writer.append(new Blob(['frames-2']));
    assert.equal(await blobText(await writer.snapshot()), 'header-frames-1-frames-2');
    const file = await writer.finish({ header: new Blob(['HEADER-']) });
    assert.equal(await blobText(file), 'HEADER-frames-1-frames-2');
    assert.deepEqual(root.list(), ['Studio/2026-11-05 2130 take/Host/Host ISO.webm']);
  });

  it('writes the manifest as JSON', async () => {
    const root = new MemoryDirectoryHandle('SSD');
    const take = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    await take.writeJson(TAKE_MANIFEST_FILE_NAME, { a: 1 });
    await take.writeJson(TAKE_MANIFEST_FILE_NAME, { a: 2 });
    assert.deepEqual(JSON.parse(await blobText(await root.readFile(`${take.path}/${TAKE_MANIFEST_FILE_NAME}`))), { a: 2 });
  });
});

describe('folder track store', () => {
  function memoryFallback(): { factory: RecordingTrackStoreFactory; stores: RecordingTrackStore[] } {
    const stores: RecordingTrackStore[] = [];
    const factory: RecordingTrackStoreFactory = (input) => {
      const chunks: Blob[] = [];
      const store: RecordingTrackStore = {
        id: `browser-${stores.length}`,
        append: (data) => { chunks.push(data); },
        flush: async () => {},
        snapshot: async (mimeType = input.mimeType) => new Blob(chunks, { type: mimeType }),
        finish: async (mimeType = input.mimeType) => new Blob(chunks, { type: mimeType }),
        discard: async () => { chunks.length = 0; },
        location: () => 'browser',
      };
      stores.push(store);
      return store;
    };
    return { factory, stores };
  }
  const input = { roomName: 'Studio', label: 'Host audio', kind: 'audio' as const, mimeType: 'audio/webm' };

  it('writes the track into the participant folder and reports the finished path', async () => {
    const root = new MemoryDirectoryHandle('SSD');
    const take = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    const finished: string[] = [];
    const factory = createFolderRecordingTrackStoreFactory({ take, participantName: 'Arnold', onTrackFinished: ({ path }) => finished.push(path) });
    const warnings: string[] = [];
    const store = factory(input, (message) => warnings.push(message));
    store.append(new Blob(['one-']));
    store.append(new Blob(['two']));
    assert.equal(await blobText(await store.snapshot()), 'one-two');
    const blob = await store.finish();
    assert.equal(await blobText(blob), 'one-two');
    assert.equal(store.location(), 'folder');
    assert.deepEqual(finished, ['Studio/2026-11-05 2130 take/Arnold/Host audio.webm']);
    assert.equal(store.folderPath?.(), finished[0]);
    assert.deepEqual(warnings, []);
  });

  it('continues in browser storage when the drive stops accepting writes, keeping every byte in order', async () => {
    let failing = false;
    const root = new MemoryDirectoryHandle('SSD', { failWrite: () => failing });
    const take = await openTakeFolder(root, { studioName: 'Studio', startedAt });
    const fallback = memoryFallback();
    const factory = createFolderRecordingTrackStoreFactory({
      take, participantName: 'Arnold', fallback: fallback.factory, writerOptions: { partBytes: 64 * 1024, partMs: 250, now: (() => { let t = 0; return () => (t += 300); })() },
    });
    const warnings: string[] = [];
    const store = factory(input, (message) => warnings.push(message));
    store.append(new Blob(['a1-']));
    await store.flush();
    failing = true;
    store.append(new Blob(['b2-']));
    store.append(new Blob(['c3']));
    const blob = await store.finish();
    assert.equal(await blobText(blob), 'a1-b2-c3');
    assert.equal(store.location(), 'browser');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /browser storage/);
    assert.equal(fallback.stores.length, 1);
  });
});
