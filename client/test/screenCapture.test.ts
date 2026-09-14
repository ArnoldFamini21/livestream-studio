import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScreenCaptureSession } from '../src/utils/screenCapture.ts';

function fakeStream() {
  let stopped = 0;
  const video = { readyState: 'live', contentHint: '', stop() { stopped++; this.readyState = 'ended'; } };
  const audio = { stop() { stopped++; } };
  return {
    stream: { getTracks: () => [video, audio], getVideoTracks: () => [video] } as unknown as MediaStream,
    video,
    stopped: () => stopped,
  };
}

function deferred() {
  let resolve!: (stream: MediaStream) => void;
  const promise = new Promise<MediaStream>(done => { resolve = done; });
  return { promise, resolve };
}

describe('screen capture lifecycle', () => {
  it('opens one picker for repeated clicks and publishes a result only once', async () => {
    const request = deferred();
    let calls = 0;
    const session = createScreenCaptureSession(() => { calls++; return request.promise; });
    const first = session.start();
    assert.equal(await session.start(), null);
    assert.equal(calls, 1);
    const source = fakeStream();
    request.resolve(source.stream);
    assert.equal(await first, source.stream);
    assert.equal(await session.start(), null);
    assert.equal(source.video.contentHint, 'detail');
    session.stop();
    assert.equal(source.stopped(), 2);
  });

  it('releases both audio and video if capture completes after leaving the studio', async () => {
    const request = deferred();
    const session = createScreenCaptureSession(() => request.promise);
    const pending = session.start();
    session.stop();
    const source = fakeStream();
    request.resolve(source.stream);
    assert.equal(await pending, null);
    assert.equal(source.stopped(), 2);
  });

  it('allows retry after cancellation and restart after stopping', async () => {
    let cancelled = true;
    const session = createScreenCaptureSession(async () => {
      if (cancelled) throw new Error('Cancelled');
      return fakeStream().stream;
    });
    await assert.rejects(session.start(), /Cancelled/);
    cancelled = false;
    const first = await session.start();
    assert.ok(first);
    session.stop();
    const second = await session.start();
    assert.ok(second);
    assert.notEqual(first, second);
    session.stop();
  });

  it('does not publish a screen that has already ended', async () => {
    const source = fakeStream();
    source.video.readyState = 'ended';
    const session = createScreenCaptureSession(async () => source.stream);
    assert.equal(await session.start(), null);
    assert.equal(source.stopped(), 2);
  });
});
