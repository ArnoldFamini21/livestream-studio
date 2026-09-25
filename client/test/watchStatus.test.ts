import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pollWatchStatus } from '../src/utils/watchStatus.ts';

it('does not overlap requests and aborts an in-flight poll on cleanup', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  let updates = 0;
  let finish: (response: Response) => void = () => {};
  const stop = pollWatchStatus('/watch/room/status', () => updates++, () => updates++, {
    intervalMs: 1,
    fetcher: async (_url, init) => {
      calls++;
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    },
  });
  try {
    await delay(20);
    assert.equal(calls, 1);
    stop();
    assert.equal(signal?.aborted, true);
    finish(Response.json({ live: false }));
    await delay(10);
    assert.equal(updates, 0);
    assert.equal(calls, 1);
  } finally { stop(); }
});

it('reports timeouts and recovers on the next successful poll', async () => {
  let calls = 0;
  let failures = 0;
  let received = false;
  let resolveRecovered: () => void = () => {};
  const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
  const stop = pollWatchStatus('/watch/room/status', (status) => {
    received = !status.live;
    resolveRecovered();
  }, () => failures++, {
    intervalMs: 1, timeoutMs: 10,
    fetcher: async (_url, init) => {
      if (++calls > 1) return Response.json({ live: false });
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    },
  });
  try {
    await Promise.race([recovered, delay(1000).then(() => { throw new Error('Did not recover'); })]);
    assert.equal(failures, 1);
    assert.equal(received, true);
  } finally { stop(); }
});

it('rejects malformed status instead of declaring a broadcast offline', async () => {
  let resolveFailed: () => void = () => {};
  const failed = new Promise<void>((resolve) => { resolveFailed = resolve; });
  let updates = 0;
  const stop = pollWatchStatus('/watch/room/status', () => updates++, resolveFailed, {
    fetcher: async () => Response.json({ message: 'Waking up' }),
  });
  try {
    await failed;
    assert.equal(updates, 0);
  } finally { stop(); }
});
