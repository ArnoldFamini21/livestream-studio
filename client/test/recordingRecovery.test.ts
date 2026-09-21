import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acknowledgeRecordingBackups, createRecoverableRecordingStore, listRecoverableRecordings, recoverRecording } from '../src/utils/recordingRecovery.ts';

function storage() {
  let failChunk = '';
  let failRemoval = false;
  const locks = new Set<string>();
  class Directory {
    directories = new Map<string, Directory>();
    files = new Map<string, Blob>();
    async getDirectoryHandle(name: string, { create }: { create: boolean }) {
      if (!this.directories.has(name)) {
        if (!create) throw new Error('Directory not found');
        this.directories.set(name, new Directory());
      }
      return this.directories.get(name)!;
    }
    async getFileHandle(name: string, { create }: { create: boolean }) {
      if (!create && !this.files.has(name)) throw new Error('File not found');
      return {
        createWritable: async () => {
          let data = new Blob();
          return {
            write: async (blob: Blob) => { if (name === failChunk) throw new Error('Disk full'); data = blob; },
            close: async () => { this.files.set(name, data); },
          };
        },
        getFile: async () => this.files.get(name) || new Blob(),
      };
    }
    async removeEntry(name: string) {
      if (failRemoval) throw new Error('Cleanup unavailable');
      this.files.delete(name); this.directories.delete(name);
    }
    async *entries(): AsyncIterableIterator<[string, { kind: string }]> {
      for (const [name] of this.directories) yield [name, { kind: 'directory' }];
      for (const [name] of this.files) yield [name, { kind: 'file' }];
    }
  }
  const root = new Directory();
  const environment = {
    root: async () => root,
    lock: async <T>(name: string, task: (available: boolean) => Promise<T>): Promise<T> => {
      if (locks.has(name)) return task(false);
      locks.add(name);
      try { return await task(true); } finally { locks.delete(name); }
    },
  };
  return { root, environment, locks, failChunk: (name: string) => { failChunk = name; }, failRemoval: () => { failRemoval = true; } };
}
const metadata = { roomName: 'Podcast', label: 'Host camera', kind: 'video' as const, mimeType: 'video/webm' };

describe('interrupted recording recovery', () => {
  it('hides active capture from other tabs and recovers committed chunks after a crash releases its lock', async () => {
    const disk = storage();
    const track = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    track.append(new Blob(['container-header'])); track.append(new Blob(['-frame1']));
    await track.flush();
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    disk.locks.clear(); // A crashed browser releases its Web Lock, without finalizing.
    const [recording] = await listRecoverableRecordings(disk.environment);
    assert.equal(recording.complete, false);
    assert.equal(recording.chunkCount, 2);
    await recoverRecording(recording.id, async input => {
      assert.equal(input.id, `recovered-${recording.id}`);
      assert.equal(input.files[0].fileName, 'Host camera_recovered.webm');
      assert.equal(await input.files[0].blob.text(), 'container-header-frame1');
      assert.equal(input.files[0].blob.type, 'video/webm');
    }, disk.environment);
    assert.equal(disk.root.directories.size, 0);
  });
  it('retains the only copy when saving to the library fails', async () => {
    const disk = storage();
    const track = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    track.append(new Blob(['header-frames'])); await track.finish();
    disk.locks.clear(); // Simulate navigating away from the capturing document.
    const [recording] = await listRecoverableRecordings(disk.environment);
    await assert.rejects(recoverRecording(recording.id, async () => { throw new Error('Quota exceeded'); }, disk.environment), /Quota exceeded/);
    assert.equal((await listRecoverableRecordings(disk.environment)).length, 1);
  });
  it('keeps finished file-backed blobs readable until navigation, then removes acknowledged backups', async () => {
    const disk = storage();
    const track = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    track.append(new Blob(['header']));
    const result = await track.finish();
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    await acknowledgeRecordingBackups([result]);
    assert.equal(disk.root.directories.size, 1);
    assert.equal(await result.text(), 'header');
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    disk.locks.clear(); // Navigation releases references to file-backed blobs.
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    assert.equal(disk.root.directories.size, 0);
  });
  it('preserves the complete in-memory result and only offers the safe disk prefix when the disk fills', async () => {
    const disk = storage(); disk.failChunk('chunk-000001.part');
    let warnings = 0;
    const track = createRecoverableRecordingStore(metadata, () => warnings++, disk.environment);
    for (const value of ['header', '-one', '-two']) track.append(new Blob([value]));
    assert.equal(await (await track.finish()).text(), 'header-one-two');
    assert.equal(warnings, 1);
    disk.locks.clear();
    const [recording] = await listRecoverableRecordings(disk.environment);
    assert.equal(recording.complete, false);
    await recoverRecording(recording.id, async input => { assert.equal(await input.files[0].blob.text(), 'header'); }, disk.environment);
  });
  it('does not join across a missing chunk or recover without the container header', async () => {
    const disk = storage();
    const track = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    for (const value of ['header', '-one', '-two']) track.append(new Blob([value]));
    await track.finish();
    disk.locks.clear(); // Simulate navigating away from the capturing document.
    const [id, directory] = [...disk.root.directories][0];
    directory.files.delete('chunk-000001.part');
    const [recording] = await listRecoverableRecordings(disk.environment);
    assert.equal(recording.complete, false); assert.equal(recording.chunkCount, 1);
    directory.files.delete('chunk-000000.part');
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    await assert.rejects(recoverRecording(id, async () => assert.fail('Must not save invalid footage'), disk.environment), /No complete/);
  });
  it('excludes empty or unrelated folders and rejects invalid recovery identifiers', async () => {
    const disk = storage();
    await disk.root.getDirectoryHandle('unrelated-user-files', { create: true });
    const empty = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    await empty.finish();
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    await assert.rejects(recoverRecording('../outside', async () => {}, disk.environment), /unavailable/);
    assert.equal(disk.root.directories.size, 2);
  });
  it('prevents concurrent recovery while the first library save is pending', async () => {
    const disk = storage();
    const track = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    track.append(new Blob(['header'])); await track.finish();
    disk.locks.clear(); // Simulate navigating away from the capturing document.
    const [recording] = await listRecoverableRecordings(disk.environment);
    let finish!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = recoverRecording(recording.id, async () => { entered(); await saving; }, disk.environment);
    await started;
    assert.deepEqual(await listRecoverableRecordings(disk.environment), []);
    await assert.rejects(recoverRecording(recording.id, async () => {}, disk.environment), /another tab/);
    finish(); await first;
  });
  it('uses a stable library id if cleanup fails and recovery is retried', async () => {
    const disk = storage();
    const track = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    track.append(new Blob(['header'])); await track.finish();
    disk.locks.clear(); // Simulate navigating away from the capturing document.
    disk.failRemoval();
    const [recording] = await listRecoverableRecordings(disk.environment);
    const saved: string[] = [];
    await recoverRecording(recording.id, async input => { saved.push(input.id); }, disk.environment);
    await recoverRecording(recording.id, async input => { saved.push(input.id); }, disk.environment);
    assert.equal(saved[0], saved[1]);
  });
  it('cancel discards only this capture and releases its cross-tab lock', async () => {
    const disk = storage();
    const first = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    const second = createRecoverableRecordingStore(metadata, undefined, disk.environment);
    first.append(new Blob(['one'])); second.append(new Blob(['two']));
    await Promise.all([first.flush(), second.flush()]);
    await first.discard();
    assert.equal(disk.locks.size, 1);
    await second.finish();
    disk.locks.clear();
    assert.equal((await listRecoverableRecordings(disk.environment)).length, 1);
  });
  it('continues recording in memory when storage cannot be initialized', async () => {
    const disk = storage(); let warnings = 0;
    disk.environment.root = async () => { throw new Error('Permission denied'); };
    const track = createRecoverableRecordingStore(metadata, () => warnings++, disk.environment);
    track.append(new Blob(['all'])); track.append(new Blob(['-footage']));
    assert.equal(await (await track.finish()).text(), 'all-footage');
    assert.equal(warnings, 1); assert.equal(disk.locks.size, 0);
  });
});
