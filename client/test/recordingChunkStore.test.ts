import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRecordingChunkStore, type RecordingChunkDirectory } from '../src/utils/recordingChunkStore.ts';

function disk(failAt = -1, failOnClose = false, waitForWrite?: (index: number) => Promise<void> | undefined) {
  let writes = 0;
  const files = new Map<string, Blob>();
  const directory: RecordingChunkDirectory = {
    async getFileHandle(name) {
      let data = new Blob();
      return {
        async createWritable() {
          const index = writes++;
          const shouldFail = index === failAt;
          return {
            async write(blob) {
              await waitForWrite?.(index);
              if (shouldFail && !failOnClose) throw new Error('Disk full');
              data = blob;
            },
            async close() { if (shouldFail && failOnClose) throw new Error('Commit failed'); files.set(name, data); },
          };
        },
        async getFile() { return files.get(name)!; },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  return { directory, files, writes: () => writes };
}

function pauseWrite() {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return {
    started,
    release,
    async wait() { start(); await released; },
  };
}

describe('recording chunk storage', () => {
  for (const failOnClose of [false, true]) {
    it(`preserves the complete recording when a middle chunk fails to ${failOnClose ? 'commit' : 'write'}`, async () => {
      const storage = disk(1, failOnClose);
      let warnings = 0;
      const store = createRecordingChunkStore(storage.directory, 'video', () => warnings++);
      for (const data of ['header', '-frame1', '-frame2', '-final']) store.append(new Blob([data]));
      const recording = await store.finish('video/webm');
      assert.equal(await recording.text(), 'header-frame1-frame2-final');
      assert.equal(recording.type, 'video/webm');
      assert.equal(warnings, 1);
      assert.equal(storage.writes(), 2, 'Stop retrying a failed disk during this capture');
      assert.equal(storage.files.size, 1, 'The already committed prefix remains available');
    });
  }
  it('waits for queued writes and keeps chunks ordered', async () => {
    const storage = disk();
    const store = createRecordingChunkStore(storage.directory);
    store.append(new Blob(['a'])); store.append(new Blob(['b'])); store.append(new Blob(['c']));
    assert.equal(await (await store.finish('audio/webm')).text(), 'abc');
    assert.equal(storage.files.size, 3);
  });
  it('batches only queued writes and keeps a flush separate from later data', async () => {
    const first = pauseWrite();
    const last = pauseWrite();
    const storage = disk(-1, false, index => index === 0 ? first.wait() : index === 2 ? last.wait() : undefined);
    const store = createRecordingChunkStore(storage.directory, 'chunk');

    store.append(new Blob(['header']));
    await first.started;
    store.append(new Blob(['-first']));
    store.append(new Blob(['-second']));
    const early = store.snapshot('video/webm');
    store.append(new Blob(['-later']));
    assert.equal(store.readCommitted().size, 0);
    first.release();

    await last.started;
    assert.equal(await (await early).text(), 'header-first-second');
    assert.deepEqual([...storage.files.keys()], ['chunk-000000.part', 'chunk-000001.part']);
    const read = store.readCommitted();
    assert.equal(await read.slice(3, 10).text(), 'der-fir');
    last.release();
    assert.equal(await (await store.finish('video/webm')).text(), 'header-first-second-later');
    assert.equal(storage.writes(), 3);
  });

  it('bounds backlog writes and retains a failed batch and later bytes in memory', async () => {
    const first = pauseWrite();
    const storage = disk(1, true, index => index === 0 ? first.wait() : undefined);
    let warnings = 0;
    const store = createRecordingChunkStore(storage.directory, 'chunk', () => warnings++);
    store.append(new Blob(['header']));
    await first.started;
    const oneMiB = new Uint8Array(1024 * 1024).fill(65);
    const part = new Blob([oneMiB]);
    store.append(part);
    store.append(part);
    store.append(new Blob(['tail']));
    first.release();

    const result = await store.finish('video/webm');
    assert.equal(result.size, 6 + 2 * part.size + 4);
    assert.equal(await result.slice(0, 8).text(), 'headerAA');
    assert.equal(await result.slice(-6).text(), 'AAtail');
    assert.equal(await store.readCommitted().slice(0, 8).text(), 'headerAA');
    assert.equal(warnings, 1);
    assert.equal(storage.writes(), 2);
    assert.deepEqual([...storage.files.keys()], ['chunk-000000.part']);
  });

  it('rolls a backlog into another part when a byte limit is reached', async () => {
    const first = pauseWrite();
    const storage = disk(-1, false, index => index === 0 ? first.wait() : undefined);
    const store = createRecordingChunkStore(storage.directory, 'chunk');
    store.append(new Blob(['header']));
    await first.started;

    const part = new Blob([new Uint8Array(1024 * 1024).fill(65)]);
    store.append(part);
    store.append(part);
    store.append(new Blob(['tail']));
    first.release();
    const result = await store.finish('video/webm');
    assert.equal(result.size, 6 + 2 * part.size + 4);
    assert.deepEqual([...storage.files.values()].map(blob => blob.size), [6, 2 * part.size, 4]);
  });

  it('snapshots committed bytes as a prefix of the finished recording', async () => {
    for (const storage of [disk(), disk(1)]) {
      const store = createRecordingChunkStore(storage.directory, 'video', () => {});
      store.append(new Blob(['header']));
      store.append(new Blob(['-frame1']));
      const early = await store.snapshot('video/webm');
      assert.equal(await early.text(), 'header-frame1', 'a snapshot waits for queued writes');
      assert.equal(early.type, 'video/webm');
      store.append(new Blob(['-frame2']));
      const finished = await store.finish('video/webm');
      assert.equal(await finished.text(), 'header-frame1-frame2');
      assert.equal(
        await finished.slice(0, early.size).text(),
        await early.text(),
        'uploaded progressive bytes stay valid after a storage fallback'
      );
    }
  });
  it('reads only the parts intersecting a committed byte range', async () => {
    const sliced: string[] = [];
    class ObservedPart extends Blob {
      constructor(private readonly contents: string) { super([contents]); }
      override slice(start?: number, end?: number): Blob {
        sliced.push(this.contents);
        return super.slice(start, end);
      }
    }
    const storage = disk(3, true);
    const store = createRecordingChunkStore(storage.directory, 'video');
    for (const contents of ['header', 'alpha', 'bravo']) {
      store.append(new ObservedPart(contents));
    }
    await store.flush();
    const original = store.readCommitted();
    assert.equal(original.size, 16);
    assert.equal(await original.slice(9, 13).text(), 'habr');
    assert.deepEqual(sliced, ['alpha', 'bravo']);
    assert.equal(await original.slice(6, 11).text(), 'alpha', 'can read a whole part directly');

    store.append(new ObservedPart('charlie'));
    assert.equal(store.readCommitted().size, original.size, 'pending writes are not included');
    await store.flush();
    assert.equal(await original.slice(15, 19).text(), 'o', 'an earlier view ends at its original length');
    const latest = store.readCommitted();
    assert.equal(latest.size, 23);
    assert.equal(await latest.slice(15, 19).text(), 'ocha', 'the read crosses from disk into the fallback');
    assert.equal(await (await store.finish('video/webm')).text(), 'headeralphabravocharlie');

    await store.discard();
    assert.equal(store.readCommitted().size, 0);
    assert.throws(() => original.slice(9, 13), { name: 'NotReadableError' });
  });

  it('supports browsers without disk storage', async () => {
    const store = createRecordingChunkStore();
    store.append(new Blob(['complete'])); store.append(new Blob());
    assert.equal(await (await store.finish('video/webm')).text(), 'complete');
  });
  it('discards owned chunks and rejects subsequent capture data after cancellation', async () => {
    const storage = disk();
    const store = createRecordingChunkStore(storage.directory);
    store.append(new Blob(['committed'])); await store.flush();
    store.append(new Blob(['pending'])); await store.discard();
    store.append(new Blob(['late event']));
    assert.equal(storage.files.size, 0);
    assert.equal((await store.finish('video/webm')).size, 0);
  });
});
