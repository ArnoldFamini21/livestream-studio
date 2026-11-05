import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createRelayVideoStream, getCoverCrop, type RelayVideoStreamDeps } from '../src/utils/relayVideoStream.ts';

interface FakeTrack {
  readyState: string;
  canvas?: { width: number; height: number };
  stopped: boolean;
  getSettings(): { width?: number; height?: number };
  stop(): void;
}

function fakeTrack(canvas?: { width: number; height: number }): FakeTrack {
  return {
    readyState: 'live',
    canvas,
    stopped: false,
    getSettings: () => (canvas ? { width: canvas.width, height: canvas.height } : {}),
    stop() { this.stopped = true; },
  };
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  return { getVideoTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

function setup() {
  const draws: unknown[][] = [];
  const tickers: Array<{ fps: number; onFrame: () => void; stopped: boolean }> = [];
  const outputTrack = fakeTrack();
  let captureRate = 0;
  const deps: RelayVideoStreamDeps = {
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => undefined,
        drawImage: (...args: unknown[]) => { draws.push(args); },
      }) as unknown as CanvasRenderingContext2D,
      captureStream: (rate?: number) => {
        captureRate = rate ?? 0;
        return fakeStream([outputTrack]);
      },
    }),
    createTicker: (fps, onFrame) => {
      const ticker = { fps, onFrame, stopped: false };
      tickers.push(ticker);
      return { stop: () => { ticker.stopped = true; } };
    },
    createSourceVideo: async () => { throw new Error('the compositor canvas should be drawn directly'); },
    createStream: (tracks) => fakeStream(tracks as unknown as FakeTrack[]),
  };
  return { deps, draws, tickers, outputTrack, captureRate: () => captureRate };
}

describe('relay video stream', () => {
  const globals = globalThis as Record<string, unknown>;
  let originalRaf: unknown;

  beforeEach(() => {
    originalRaf = globals.requestAnimationFrame;
    // A hidden studio tab never runs rAF; the relay must not depend on it.
    globals.requestAnimationFrame = () => { throw new Error('requestAnimationFrame must not drive the relay'); };
  });
  afterEach(() => {
    globals.requestAnimationFrame = originalRaf;
  });

  it('sends the compositor track untouched at its own size', async () => {
    const { deps, tickers } = setup();
    const source = fakeTrack({ width: 1920, height: 1080 });
    const result = await createRelayVideoStream(fakeStream([source]), { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 }, deps);
    assert.equal(result.stream.getVideoTracks()[0], source as unknown as MediaStreamTrack);
    assert.equal(tickers.length, 0);
  });

  it('scales 720p and portrait on the worker frame ticker, from the compositor canvas', async () => {
    const { deps, draws, tickers, outputTrack, captureRate } = setup();
    const canvas = { width: 1920, height: 1080 };
    const result = await createRelayVideoStream(
      fakeStream([fakeTrack(canvas)]),
      { width: 1080, height: 1920, frameRate: 30, videoBitsPerSecond: 4_500_000 },
      deps
    );
    assert.equal(tickers.length, 1);
    assert.equal(tickers[0].fps, 30);
    assert.equal(captureRate(), 30);
    const before = draws.length;
    tickers[0].onFrame();
    tickers[0].onFrame();
    assert.equal(draws.length, before + 2, 'each tick draws a frame, even with rAF unavailable');
    const [image, sx, sy, sw, sh, dx, dy, dw, dh] = draws.at(-1)!;
    assert.equal(image, canvas);
    assert.deepEqual([sx, sy, sw, sh, dx, dy, dw, dh], [656.25, 0, 607.5, 1080, 0, 0, 1080, 1920]);

    result.cleanup();
    assert.equal(tickers[0].stopped, true);
    assert.equal(outputTrack.stopped, true);
  });

  it('centre-crops like object-fit: cover', () => {
    assert.deepEqual(getCoverCrop(1920, 1080, 1280, 720), { sx: 0, sy: 0, sw: 1920, sh: 1080 });
    assert.deepEqual(getCoverCrop(1920, 1080, 1080, 1920), { sx: 656.25, sy: 0, sw: 607.5, sh: 1080 });
    assert.equal(getCoverCrop(0, 1080, 1280, 720), null);
  });

  it('rejects a stream without a live video track', async () => {
    const { deps } = setup();
    const ended = { ...fakeTrack(), readyState: 'ended' };
    await assert.rejects(createRelayVideoStream(fakeStream([ended]), { width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 1 }, deps), /not ready/);
  });
});
