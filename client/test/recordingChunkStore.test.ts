import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRecordingChunkStore, type RecordingChunkDirectory } from '../src/utils/recordingChunkStore.ts';

function disk(failAt = -1, failOnClose = false) {
  let writes = 0;
  const files = new Map<string, Blob>();
  const directory: RecordingChunkDirectory = {
    async getFileHandle(name) {
      let data = new Blob();
      return {
        async createWritable() {
          const shouldFail = writes++ === failAt;
          return {
            async write(blob) { if (shouldFail && !failOnClose) throw new Error('Disk full'); data = blob; },
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
