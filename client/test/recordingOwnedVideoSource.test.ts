import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createRecordingOwnedVideoSource } from '../src/utils/recordingOwnedVideoSource.ts';

function stubGlobal(t: TestContext, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

class CameraFrame {
  readonly format = 'I420';
  readonly codedWidth = 2;
  readonly codedHeight = 2;
  readonly displayWidth = 2;
  readonly displayHeight = 2;
  readonly duration = 31_000;
  readonly colorSpace = { toJSON: () => ({ matrix: 'bt709' }) };
  closed = false;
  readonly reads: (string | undefined)[] = [];

  constructor(readonly timestamp: number, readonly pixel: number, private readonly requiresRgb = false) {}

  allocationSize(options: VideoFrameCopyToOptions) {
    return options.format === 'RGBA' ? 16 : 6;
  }

  async copyTo(buffer: ArrayBuffer, options: VideoFrameCopyToOptions) {
    this.reads.push(options.format);
    assert.equal(this.closed, false);
    if (this.requiresRgb && !options.format) throw new DOMException('Texture needs RGB', 'NotSupportedError');
    const bytes = new Uint8Array(buffer);
    bytes.fill(this.pixel);
    return options.format ? [{ offset: 0, stride: 8 }] : [{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }];
  }

  close() {
    this.closed = true;
  }
}

test('copies camera pixels before enqueueing and drains each accepted frame with its original interval', async (t) => {
  const frames = [new CameraFrame(100_000, 37, true), new CameraFrame(153_000, 96)];
  const firstEncode = Promise.withResolvers<void>();
  const releaseFirstEncode = Promise.withResolvers<void>();
  const secondEncode = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let reads = 0;
  let cancelled = false;

  class OwnedFrame {
    readonly sourcePixels: Uint8Array;
    closed = false;
    constructor(pixels: ArrayBuffer, readonly init: VideoFrameBufferInit) {
      assert.equal(frames[reads - 1].closed, true, 'camera frame released before owned frame allocation');
      this.sourcePixels = new Uint8Array(pixels).slice();
    }
    close() { this.closed = true; }
  }
  class CapturedSample {
    constructor(readonly frame: OwnedFrame) {}
    close() { this.frame.close(); }
  }
  const encoded: OwnedFrame[] = [];
  class Source {
    async add(sample: CapturedSample) {
      encoded.push(sample.frame);
      if (encoded.length === 1) {
        firstEncode.resolve();
        await releaseFirstEncode.promise;
      } else {
        secondEncode.resolve();
      }
    }
  }

  stubGlobal(t, 'VideoFrame', OwnedFrame);
  stubGlobal(t, 'MediaStreamTrackProcessor', class {
    constructor(options: { maxBufferSize: number }) { assert.equal(options.maxBufferSize, 1); }
    readable = {
      getReader: () => ({
        read: async () => {
          const value = frames[reads++];
          return value ? { done: false, value } : (await finished.promise, { done: true });
        },
        cancel: async () => { cancelled = true; finished.resolve(); },
        releaseLock: () => {},
      }),
    };
  });
  const library = { VideoSample: CapturedSample, VideoSampleSource: Source };
  const capture = createRecordingOwnedVideoSource({} as MediaStreamTrack, { codec: 'vp9', bitrate: 4_000_000 },
    library as unknown as Parameters<typeof createRecordingOwnedVideoSource>[2]);
  const first = Promise.race([firstEncode.promise, capture.errorPromise]);
  capture.start(() => 0.02);
  await first;
  assert.equal(reads, 1, 'backpressure bounds reads while an encode is in flight');
  releaseFirstEncode.resolve();
  await Promise.race([secondEncode.promise, capture.errorPromise]);
  await capture.stop();
  assert.equal(cancelled, true);
  assert.deepEqual(frames.map(frame => frame.reads), [[undefined, 'RGBA'], ['RGBA']]);
  assert.deepEqual(encoded.map(frame => frame.init.timestamp), [20_000, 73_000]);
  assert.deepEqual(encoded.map(frame => frame.init.duration), [31_000, 31_000]);
  assert.deepEqual(encoded.map(frame => frame.sourcePixels[0]), [37, 96]);
  assert.ok(encoded.every(frame => frame.closed));
});
