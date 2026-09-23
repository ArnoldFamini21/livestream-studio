import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiRequestError } from '../src/utils/apiClient.ts';
import {
  STUDIO_SERVER_UNAVAILABLE_MESSAGE,
  isLostRequest,
  postWhenStudioServerReady,
  waitForStudioServer,
} from '../src/utils/studioServerWake.ts';

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

const healthSequence = (results: boolean[]) => {
  let calls = 0;
  const fetchImpl = (async () => {
    const ok = results[Math.min(calls, results.length - 1)];
    calls += 1;
    if (!ok) throw new TypeError('Failed to fetch');
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
};

describe('studio server wake-up', () => {
  it('returns at once when the server is up', async () => {
    const health = healthSequence([true]);
    await waitForStudioServer(120_000, { ...clock(), fetchImpl: health.fetchImpl, healthUrl: '/health' });
    assert.equal(health.calls(), 1);
  });

  it('keeps polling while the server restarts', async () => {
    const health = healthSequence([false, false, false, true]);
    await waitForStudioServer(120_000, { ...clock(), fetchImpl: health.fetchImpl, healthUrl: '/health' });
    assert.equal(health.calls(), 4);
  });

  it('gives up with a clear message', async () => {
    const health = healthSequence([false]);
    await assert.rejects(
      () => waitForStudioServer(10_000, { ...clock(), fetchImpl: health.fetchImpl, healthUrl: '/health' }),
      (error: unknown) => error instanceof ApiRequestError && error.message === STUDIO_SERVER_UNAVAILABLE_MESSAGE
    );
  });

  it('classifies lost requests', () => {
    assert.equal(isLostRequest(new ApiRequestError('t', { timedOut: true })), true);
    assert.equal(isLostRequest(new ApiRequestError('net')), true);
    assert.equal(isLostRequest(new ApiRequestError('bad gateway', { status: 502 })), true);
    assert.equal(isLostRequest(new ApiRequestError('quota', { status: 429 })), false);
    assert.equal(isLostRequest(new ApiRequestError('bad', { status: 400 })), false);
  });

  it('retries a create once when the first request is lost to a restart', async () => {
    const health = healthSequence([true]);
    let attempts = 0;
    let waited = false;
    const post = (async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiRequestError('Studio server timed out.', { timedOut: true });
      return { id: 'room-1' };
    }) as never;
    const result = await postWhenStudioServerReady<{ id: string }>('/api/rooms', { name: 'x' }, {
      ...clock(), fetchImpl: health.fetchImpl, healthUrl: '/health', post, onWaiting: () => { waited = true; },
    });
    assert.deepEqual(result, { id: 'room-1' });
    assert.equal(attempts, 2);
    assert.equal(waited, true);
  });

  it('does not retry real errors like a studio quota', async () => {
    const health = healthSequence([true]);
    let attempts = 0;
    const post = (async () => {
      attempts += 1;
      throw new ApiRequestError('Too many studios', { status: 429 });
    }) as never;
    await assert.rejects(() => postWhenStudioServerReady('/api/rooms', {}, { ...clock(), fetchImpl: health.fetchImpl, healthUrl: '/health', post }), /Too many studios/);
    assert.equal(attempts, 1);
  });
});
