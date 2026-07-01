import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canUseWebCodecsVideoRecorder,
  createWebCodecsVideoTrackRecorder,
  getWebCodecsBitstreamMimeType,
  resolveWebCodecsVideoRecorderConfig,
  type WebCodecsRecordingEnvironment,
} from '../src/utils/webCodecsRecording.ts';

class FakeEncodedVideoChunk {
  type: string;
  timestamp: number;
  duration: number;
  byteLength: number;
  private readonly bytes: Uint8Array;

  constructor(type: string, timestamp: number, bytes: number[]) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = 33_333;
    this.bytes = new Uint8Array(bytes);
    this.byteLength = this.bytes.byteLength;
  }

  copyTo(destination: Uint8Array) {
    destination.set(this.bytes);
  }
}

class FakeVideoFrame {
  closed = false;

  constructor(readonly id: number, readonly timestamp: number) {}

  close() {
    this.closed = true;
  }
}

class FakeVideoEncoder {
  static configs: unknown[] = [];
  private readonly output: (chunk: FakeEncodedVideoChunk) => void;
  config: unknown = null;
  closed = false;

  static async isConfigSupported(config: unknown) {
    FakeVideoEncoder.configs.push(config);
    return { supported: true, config };
  }

  constructor(init: { output: (chunk: FakeEncodedVideoChunk) => void; error: (error: unknown) => void }) {
    this.output = init.output;
  }

  configure(config: unknown) {
    this.config = config;
  }

  encode(frame: FakeVideoFrame, options?: { keyFrame?: boolean }) {
    this.output(new FakeEncodedVideoChunk(options?.keyFrame ? 'key' : 'delta', frame.timestamp, [
      options?.keyFrame ? 1 : 0,
      frame.id,
    ]));
  }

  async flush() {}

  close() {
    this.closed = true;
  }
}

function createTrack(settings: Record<string, unknown> = {}): MediaStreamTrack {
  return {
    kind: 'video',
    readyState: 'live',
    getSettings: () => settings,
  } as unknown as MediaStreamTrack;
}

function createStream(track: MediaStreamTrack): MediaStream {
  return {
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

function createEnvironment(frames: FakeVideoFrame[]): WebCodecsRecordingEnvironment {
  const reader = {
    index: 0,
    async read() {
      const value = frames[this.index++];
      return value ? { done: false, value } : { done: true };
    },
    async cancel() {
      this.index = frames.length;
    },
  };

  return {
    VideoEncoder: FakeVideoEncoder as unknown as WebCodecsRecordingEnvironment['VideoEncoder'],
    MediaStreamTrackProcessor: class {
      readable = {
        getReader: () => reader,
      };
    } as unknown as WebCodecsRecordingEnvironment['MediaStreamTrackProcessor'],
    now: (() => {
      let time = 1_000;
      return () => {
        time += 500;
        return time;
      };
    })(),
  };
}

describe('WebCodecs video recording core', () => {
  it('detects the required browser APIs', () => {
    assert.equal(canUseWebCodecsVideoRecorder({}), false);
    assert.equal(canUseWebCodecsVideoRecorder(createEnvironment([])), true);
  });

  it('resolves bounded encoder config from a live video track', () => {
    const track = createTrack({ width: 1280, height: 720, frameRate: 60 });
    const resolved = resolveWebCodecsVideoRecorderConfig({
      stream: createStream(track),
      presetId: '1080p',
      contentType: 'video/webm;codecs=vp9',
      bitsPerSecond: 12_000_000,
    });

    assert.equal(resolved?.track, track);
    assert.equal(resolved?.config.codec, 'vp09.00.10.08');
    assert.equal(resolved?.config.width, 1280);
    assert.equal(resolved?.config.height, 720);
    assert.equal(resolved?.config.framerate, 30);
    assert.equal(resolved?.config.bitrate, 12_000_000);
    assert.equal(resolved?.config.hardwareAcceleration, 'prefer-hardware');
    assert.equal(resolved?.mimeType, 'video/x-vp9');
    assert.equal(getWebCodecsBitstreamMimeType('vp8'), 'video/x-vp8');
  });

  it('encodes video frames into bounded copied chunks', async () => {
    FakeVideoEncoder.configs = [];
    const frames = [
      new FakeVideoFrame(1, 0),
      new FakeVideoFrame(2, 33_333),
      new FakeVideoFrame(3, 66_666),
    ];
    const recorder = createWebCodecsVideoTrackRecorder({
      stream: createStream(createTrack({ width: 1920, height: 1080, frameRate: 30 })),
      presetId: '1080p',
      contentType: 'video/webm;codecs=vp8',
      keyFrameIntervalFrames: 2,
      environment: createEnvironment(frames),
    });

    const config = await recorder.start();
    const result = await recorder.stop({ drain: true });

    assert.equal(config.config.codec, 'vp8');
    assert.equal(FakeVideoEncoder.configs.length, 1);
    assert.equal(result.framesEncoded, 3);
    assert.equal(result.mimeType, 'video/x-vp8');
    assert.equal(result.blob.type, 'video/x-vp8');
    assert.deepEqual(result.chunks.map((chunk) => chunk.type), ['key', 'delta', 'key']);
    assert.deepEqual(result.chunks.map((chunk) => Array.from(chunk.data)), [[1, 1], [0, 2], [1, 3]]);
    assert.equal(frames.every((frame) => frame.closed), true);
    assert.equal(result.durationMs, 500);
  });
});
