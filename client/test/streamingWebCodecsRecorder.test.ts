import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { prepareStreamingWebCodecsRecorder, StreamingWebCodecsRecorder } from '../src/utils/streamingWebCodecsRecorder.ts';

class TestBlobEvent extends Event {
  readonly data: Blob;
  constructor(type: string, init: { data: Blob }) {
    super(type);
    this.data = init.data;
  }
}

class TestErrorEvent extends Event {
  readonly message: string;
  constructor(type: string, init: { message: string }) {
    super(type);
    this.message = init.message;
  }
}

function provideGlobals(context: TestContext, values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    const existing = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => {
      if (existing) Object.defineProperty(globalThis, name, existing);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

function fixture(context: TestContext) {
  provideGlobals(context, { BlobEvent: TestBlobEvent, ErrorEvent: TestErrorEvent });

  type Packet = { timestamp: number; duration: number; byteLength: number };
  type TrackSourceOptions = { onEncodedPacket: (packet: Packet) => void };
  const sources: FakeSource[] = [];
  class FakeSource {
    paused = false;
    readonly errorPromise = new Promise<never>(() => {});
    constructor(
      readonly track: EventTarget,
      readonly options: TrackSourceOptions,
      readonly captureOptions?: { frameRate: number | null },
    ) {
      sources.push(this);
    }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
  }

  class FakeTarget {
    constructor(readonly writable: WritableStream<Uint8Array>) {}
  }

  let releaseDrain!: () => void;
  const allowDrain = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let draining = false;
  class FakeOutput {
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    constructor({ target }: { target: FakeTarget }) {
      this.writer = target.writable.getWriter();
    }
    addVideoTrack() {}
    addAudioTrack() {}
    async start() {
      const header = new Uint8Array([1, 2, 3]);
      await this.writer.write(header);
      header.fill(0);
    }
    async finalize() {
      draining = true;
      assert.ok(sources.every(source => source.paused));
      await allowDrain;
      await this.writer.write(new Uint8Array([4, 5, 6]));
      await this.writer.close();
    }
  }

  function track(kind: 'audio' | 'video') {
    return Object.assign(new EventTarget(), { kind, readyState: 'live' });
  }

  const library = {
    Output: FakeOutput,
    MediaStreamVideoTrackSource: FakeSource,
    MediaStreamAudioTrackSource: FakeSource,
    AppendOnlyStreamTarget: FakeTarget,
    WebMOutputFormat: class {},
  };
  const recorder = new StreamingWebCodecsRecorder(
    {} as MediaStream,
    track('video') as unknown as ConstructorParameters<typeof StreamingWebCodecsRecorder>[1],
    track('audio') as unknown as ConstructorParameters<typeof StreamingWebCodecsRecorder>[2],
    { videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 256_000 },
    library as unknown as typeof import('mediabunny'),
  );
  const chunks: Blob[] = [];
  const started = new Promise<void>((resolve) => { recorder.onstart = () => resolve(); });
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.ondataavailable = ({ data }) => chunks.push(data);
  context.after(() => { recorder.stop(); releaseDrain(); });
  return { recorder, sources, chunks, started, stopped, releaseDrain, isDraining: () => draining };
}

test('streaming recorder forwards original bytes and waits for both encoder tails', { timeout: 5000 }, async (context) => {
  const run = fixture(context);
  run.recorder.start();
  await run.started;
  assert.equal(run.sources[0].captureOptions?.frameRate, null);
  run.recorder.pause();
  assert.equal(run.recorder.state, 'paused');
  assert.ok(run.sources.every(source => source.paused));
  run.recorder.resume();
  assert.ok(run.sources.every(source => !source.paused));

  run.recorder.stop();
  assert.equal(run.recorder.state, 'inactive');
  await Promise.resolve();
  assert.equal(run.isDraining(), true);
  assert.equal(run.chunks.length, 0);
  run.releaseDrain();
  await run.stopped;
  assert.deepEqual([...new Uint8Array(await new Blob(run.chunks).arrayBuffer())], [1, 2, 3, 4, 5, 6]);
});

test('streaming recorder reports excessive track holdback and drains existing output', { timeout: 5000 }, async (context) => {
  const run = fixture(context);
  const error = new Promise<string>((resolve) => { run.recorder.onerror = (event) => resolve(event.message); });
  run.recorder.start();
  await run.started;
  run.sources[0].options.onEncodedPacket({ timestamp: 6, duration: 0.033, byteLength: 42 });
  assert.match(await error, /could not keep up/);
  assert.equal(run.recorder.state, 'inactive');
  run.releaseDrain();
  await run.stopped;
  assert.deepEqual([...new Uint8Array(await new Blob(run.chunks).arrayBuffer())], [1, 2, 3, 4, 5, 6]);
});

test('preparation passes the exact numeric encoder bitrates to the native support checks', async (context) => {
  let checkedVideo: VideoEncoderConfig | undefined;
  let checkedAudio: AudioEncoderConfig | undefined;
  provideGlobals(context, {
    MediaStreamTrackProcessor: class {},
    VideoEncoder: class {
      static async isConfigSupported(config: VideoEncoderConfig) {
        checkedVideo = config;
        return { supported: true, config };
      }
    },
    AudioEncoder: class {
      static async isConfigSupported(config: AudioEncoderConfig) {
        checkedAudio = config;
        return { supported: true, config };
      }
    },
  });
  const stream = {
    getVideoTracks: () => [{ kind: 'video', readyState: 'live', getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) }],
    getAudioTracks: () => [{ kind: 'audio', readyState: 'live', getSettings: () => ({}) }],
  } as unknown as MediaStream;

  const recorder = await prepareStreamingWebCodecsRecorder(stream, {
    videoBitsPerSecond: 20_000_000,
    audioBitsPerSecond: 256_000,
  });

  assert.equal(recorder?.stream, stream);
  assert.equal(checkedVideo?.bitrate, 20_000_000);
  assert.equal(checkedVideo?.width, 1920);
  assert.equal(checkedVideo?.height, 1080);
  assert.equal(checkedAudio?.bitrate, 256_000);
  assert.equal(checkedAudio?.sampleRate, 48_000);
  assert.equal(checkedAudio?.numberOfChannels, 2);
});
