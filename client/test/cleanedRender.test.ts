import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KeepRangeMapper,
  applyEdgeFades,
  buildRenderFileName,
  chooseRenderVideoBitrate,
  computeRenderProgress,
  getBrowserRenderSupport,
  splitAudioBlock,
  toEvenDimension,
} from '../src/utils/cleanedRenderPlan.ts';
import { findFreeFileName, openRenderOutputFolder } from '../src/utils/renderOutputFolder.ts';
import { renderCleanedTrack } from '../src/utils/cleanedRender.ts';

const segments = [
  { sourceStart: 0, sourceEnd: 2, recordStart: 0 },
  { sourceStart: 3, sourceEnd: 5, recordStart: 2 },
];

describe('cleaned render planning', () => {
  it('detects WebCodecs and explains what is missing', () => {
    const all = { VideoDecoder() {}, VideoEncoder() {}, AudioDecoder() {}, AudioEncoder() {} };
    assert.deepEqual(getBrowserRenderSupport(all), { supported: true });
    const oldSafari = getBrowserRenderSupport({});
    assert.equal(oldSafari.supported, false);
    assert.match(oldSafari.reason || '', /Safari before 17/);
    const noAudio = getBrowserRenderSupport({ VideoDecoder() {}, VideoEncoder() {} });
    assert.match(noAudio.reason || '', /audio/);
  });

  it('drops frames inside cuts and re-times kept ones', () => {
    const mapper = new KeepRangeMapper(segments);
    assert.equal(mapper.map(0), 0);
    assert.equal(mapper.map(1.5), 1.5);
    assert.equal(mapper.map(2.4), null);
    assert.equal(mapper.done, false);
    assert.equal(mapper.map(3), 2);
    assert.equal(mapper.map(4.5), 3.5);
    assert.equal(mapper.map(5), null);
    assert.equal(mapper.done, true);
  });

  it('splits an audio block that straddles a cut', () => {
    // 1.9 s .. 3.1 s at 100 Hz = 120 frames.
    const spans = splitAudioBlock(segments, 1.9, 120, 100);
    assert.deepEqual(spans, [
      { startFrame: 0, endFrame: 10, outputTimestamp: 1.9, fadeIn: false, fadeOut: true },
      { startFrame: 110, endFrame: 120, outputTimestamp: 2, fadeIn: true, fadeOut: false },
    ]);
    assert.deepEqual(splitAudioBlock(segments, 2.2, 50, 100), []);
    // Inside a segment: kept whole, no fades.
    assert.deepEqual(splitAudioBlock(segments, 0.5, 50, 100), [
      { startFrame: 0, endFrame: 50, outputTimestamp: 0.5, fadeIn: false, fadeOut: false },
    ]);
  });

  it('fades the edges of a join', () => {
    const plane = new Float32Array(1000).fill(1);
    applyEdgeFades([plane], 48_000, true, true);
    assert.equal(plane[0], 0);
    assert.equal(plane[999], 0);
    assert.ok(plane[120] > 0.4 && plane[120] < 0.6);
    assert.equal(plane[500], 1);
  });

  it('picks sensible bitrates, even sizes and file names', () => {
    assert.equal(chooseRenderVideoBitrate(1920, 1080), 8_100_000);
    assert.equal(chooseRenderVideoBitrate(320, 180), 1_500_000);
    assert.equal(chooseRenderVideoBitrate(3840, 2160, 60), 20_000_000);
    assert.equal(toEvenDimension(1081), 1080);
    assert.equal(toEvenDimension(720), 720);
    assert.equal(buildRenderFileName('My Show: Ep 1', 'Program', 'mp4'), 'My_Show_Ep_1_Program_cleaned.mp4');
    assert.deepEqual(computeRenderProgress(5, 10), { fraction: 0.5, renderedSeconds: 5, totalSeconds: 10 });
  });

  it('refuses an empty cut before loading the media library', async () => {
    await assert.rejects(renderCleanedTrack({
      blob: new Blob(['x']),
      label: 'Program',
      segments: [],
      output: { writable: null, complete: async () => ({ savedTo: '' }), discard: async () => {} },
    }), /Nothing of Program is kept/);
  });
});

class FakeFile {
  data = new Uint8Array(0);
  constructor(readonly name: string) {}
  async createWritable() {
    const file = this;
    return new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      write(chunk) {
        const end = chunk.position + chunk.data.byteLength;
        if (end > file.data.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(file.data);
          file.data = grown;
        }
        file.data.set(chunk.data, chunk.position);
      },
    });
  }
  async getFile() {
    return new File([this.data], this.name);
  }
}

class FakeDirectory {
  readonly files = new Map<string, FakeFile>();
  readonly directories = new Map<string, FakeDirectory>();
  constructor(readonly name: string) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options?.create) throw new DOMException('missing', 'NotFoundError');
      directory = new FakeDirectory(name);
      this.directories.set(name, directory);
    }
    return directory;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file) {
      if (!options?.create) throw new DOMException('missing', 'NotFoundError');
      file = new FakeFile(name);
      this.files.set(name, file);
    }
    return file;
  }
  async removeEntry(name: string) {
    this.files.delete(name);
    this.directories.delete(name);
  }
  async *keys() {
    yield* this.files.keys();
  }
  async queryPermission() {
    return 'granted' as PermissionState;
  }
}

describe('render output folder', () => {
  it('never overwrites an earlier export', async () => {
    const taken = new Set(['show.mp4', 'show (2).mp4']);
    assert.equal(await findFreeFileName(async (name) => taken.has(name), 'show.mp4'), 'show (3).mp4');
  });

  it('streams into <Studio>/Exports of the recording folder on the SSD', async () => {
    const root = new FakeDirectory('X9 Pro');
    const folder = await openRenderOutputFolder({
      studioName: 'Arnold Studio',
      store: { get: async () => root, set: async () => {}, clear: async () => {} },
      scope: {},
    });
    assert.equal(folder.kind, 'recording-folder');
    assert.equal(folder.label, 'X9 Pro/Arnold Studio/Exports');

    const output = await folder.createFile('take_cleaned.mp4', 'video/mp4');
    const writer = output.writable!.getWriter();
    await writer.write({ type: 'write', data: new Uint8Array([1, 2, 3, 4]), position: 0 });
    await writer.write({ type: 'write', data: new Uint8Array([9]), position: 1 });
    await writer.close();
    assert.deepEqual(await output.complete(), { savedTo: 'X9 Pro/Arnold Studio/Exports/take_cleaned.mp4' });
    const exports = root.directories.get('Arnold Studio')!.directories.get('Exports')!;
    assert.deepEqual([...exports.files.get('take_cleaned.mp4')!.data], [1, 9, 3, 4]);

    const second = await folder.createFile('take_cleaned.mp4', 'video/mp4');
    await second.discard();
    assert.deepEqual([...exports.files.keys()], ['take_cleaned.mp4']);
  });

  it('falls back to browser storage and a download, then to memory', async () => {
    const opfs = new FakeDirectory('opfs');
    const browser = await openRenderOutputFolder({
      studioName: 'Studio',
      store: { get: async () => null, set: async () => {}, clear: async () => {} },
      scope: { navigator: { storage: { getDirectory: async () => opfs } } },
    });
    assert.equal(browser.kind, 'browser-storage');
    const file = await browser.createFile('a.mp4', 'video/mp4');
    await file.writable!.getWriter().close();
    const result = await file.complete();
    assert.equal(result.savedTo, 'a.mp4');
    assert.ok(result.download instanceof Blob);

    const memory = await openRenderOutputFolder({ studioName: 'Studio', store: undefined, scope: {} });
    assert.equal(memory.kind, 'memory');
    const buffered = await memory.createFile('b.mp4', 'video/mp4');
    assert.equal(buffered.writable, null);
    const download = (await buffered.complete(new Uint8Array([1, 2]).buffer)).download;
    assert.equal(download?.type, 'video/mp4');
    assert.equal(download?.size, 2);
  });
});
