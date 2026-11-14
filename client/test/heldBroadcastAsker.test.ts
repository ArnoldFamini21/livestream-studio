import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS,
  HeldBroadcastUnsupportedError,
  createHeldBroadcastAsker,
  fetchHeldBroadcast,
} from '../src/utils/heldBroadcastAsker.ts';
import type { HeldBroadcastAnswer } from '../src/utils/heldBroadcastState.ts';

const held: HeldBroadcastAnswer = { held: true, state: 'held', secondsLeft: 100, destinations: [] };
const none: HeldBroadcastAnswer = { held: false, state: 'none', secondsLeft: 0, destinations: [] };

/** Timers the test runs by hand. */
function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    setTimer: (callback: () => void, ms: number) => { pending.set(next, { callback, ms }); return next++; },
    clearTimer: (handle: unknown) => { pending.delete(handle as number); },
    count: () => pending.size,
    delays: () => [...pending.values()].map((item) => item.ms),
    fire: () => {
      const [id, item] = [...pending.entries()][0];
      pending.delete(id);
      item.callback();
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(answers: Array<HeldBroadcastAnswer | Error>) {
  const timers = fakeTimers();
  const seen: HeldBroadcastAnswer[] = [];
  const errors: unknown[] = [];
  let asked = 0;
  const asker = createHeldBroadcastAsker({
    ask: async () => {
      const item = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
      if (item instanceof Error) throw item;
      return item;
    },
    onAnswer: (answer) => seen.push(answer),
    onError: (error) => errors.push(error),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { asker, timers, seen, errors, asked: () => asked };
}

describe('createHeldBroadcastAsker', () => {
  it('asks once at the start and stops when nothing is held', async () => {
    const { asker, timers, seen, asked } = setup([none]);
    asker.start();
    await settle();
    assert.equal(asked(), 1);
    assert.deepEqual(seen, [none]);
    assert.equal(timers.count(), 0, 'no further ask is planned');
    assert.equal(asker.running, false);
  });

  it('asks again every 10 seconds while a hold is reported, and stops when the hold is gone', async () => {
    const { asker, timers, seen, asked } = setup([held, held, none]);
    asker.start();
    await settle();
    assert.deepEqual(timers.delays(), [10_000]);
    timers.fire();
    await settle();
    assert.equal(asked(), 2);
    assert.deepEqual(timers.delays(), [10_000]);
    timers.fire();
    await settle();
    assert.equal(asked(), 3);
    assert.equal(timers.count(), 0);
    assert.equal(seen.length, 3);
    assert.equal(asker.running, false);
  });

  it('stop cancels the planned ask and ignores an answer still on its way', async () => {
    const { asker, timers, seen, asked } = setup([held]);
    asker.start();
    await settle();
    asker.stop();
    assert.equal(timers.count(), 0);
    assert.equal(asker.running, false);

    const late = setup([held]);
    late.asker.start();
    late.asker.stop();
    await settle();
    assert.equal(late.seen.length, 0, 'an answer after stop is dropped');
    assert.equal(late.timers.count(), 0);
    assert.equal(seen.length, 1);
    assert.equal(asked(), 1);
  });

  it('a failed first ask is retried quickly, then every 30 seconds, for about three minutes, and then the asking ends', async () => {
    assert.deepEqual(HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS.slice(0, 4), [2_000, 4_000, 8_000, 15_000]);
    assert.ok(HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS.slice(4).every((ms) => ms === 30_000));
    const total = HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    assert.ok(total >= 170_000 && total <= 180_000, `the retries span the 3 minutes a broadcast is held, got ${total}`);

    const { asker, timers, errors, seen, asked } = setup([new Error('offline')]);
    asker.start();
    await settle();
    assert.equal(errors.length, 1);
    assert.equal(asker.running, true, 'still trying');
    for (const delay of HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS) {
      assert.deepEqual(timers.delays(), [delay]);
      timers.fire();
      await settle();
    }
    assert.equal(asked(), HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS.length + 1);
    assert.equal(errors.length, asked());
    assert.equal(timers.count(), 0, 'no further ask');
    assert.equal(asker.running, false);
    assert.equal(seen.length, 0);
  });

  it('while a hold is shown, failures are retried every 10 seconds without a limit', async () => {
    const { asker, timers, errors, asked } = setup([new Error('offline')]);
    asker.start(true);
    await settle();
    for (let round = 1; round <= 12; round++) {
      assert.deepEqual(timers.delays(), [10_000], `after failure ${round}`);
      timers.fire();
      await settle();
    }
    assert.equal(asked(), 13);
    assert.equal(errors.length, 13);
    assert.equal(asker.running, true);
    asker.stop();
    assert.equal(timers.count(), 0);
  });

  it('an old media server found on a retry ends the asking', async () => {
    const { asker, timers, errors, asked } = setup([new Error('blip'), new HeldBroadcastUnsupportedError()]);
    asker.start();
    await settle();
    timers.fire();
    await settle();
    assert.equal(asked(), 2);
    assert.equal(errors.length, 2);
    assert.equal(timers.count(), 0);
    assert.equal(asker.running, false);
  });

  it('a retry that gets an answer shows the hold and goes on asking every 10 seconds', async () => {
    const { asker, timers, seen, asked } = setup([new Error('blip'), new Error('blip'), held, none]);
    asker.start();
    await settle();
    timers.fire();
    await settle();
    timers.fire();
    await settle();
    assert.equal(asked(), 3);
    assert.deepEqual(seen, [held]);
    assert.deepEqual(timers.delays(), [10_000]);
    timers.fire();
    await settle();
    assert.deepEqual(seen, [held, none]);
    assert.equal(asker.running, false);
  });

  it('a retry that learns nothing is held ends the asking', async () => {
    const { asker, timers, seen, asked } = setup([new Error('blip'), none]);
    asker.start();
    await settle();
    timers.fire();
    await settle();
    assert.equal(asked(), 2);
    assert.deepEqual(seen, [none]);
    assert.equal(timers.count(), 0);
    assert.equal(asker.running, false);
  });

  it('an old media server is not retried', async () => {
    const { asker, timers, errors, asked } = setup([new HeldBroadcastUnsupportedError()]);
    asker.start();
    await settle();
    assert.equal(errors.length, 1);
    assert.equal(asked(), 1);
    assert.equal(timers.count(), 0);
    assert.equal(asker.running, false);
  });

  it('stop cancels a planned retry, and a new start gets the full set of retries again', async () => {
    const { asker, timers, asked } = setup([new Error('offline')]);
    asker.start();
    await settle();
    timers.fire();
    await settle();
    assert.deepEqual(timers.delays(), [4_000]);
    asker.stop();
    assert.equal(timers.count(), 0);
    asker.start();
    await settle();
    assert.deepEqual(timers.delays(), [2_000], 'the count starts over');
    assert.equal(asked(), 3);
  });

  it('retries can be switched off', async () => {
    const timers = fakeTimers();
    let asked = 0;
    const asker = createHeldBroadcastAsker({
      ask: async () => { asked += 1; throw new Error('offline'); },
      onAnswer: () => {},
      firstAskRetryDelaysMs: [],
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    asker.start();
    await settle();
    assert.equal(asked, 1);
    assert.equal(timers.count(), 0);
    assert.equal(asker.running, false);
  });

  it('keeps asking after a failure while a hold is known', async () => {
    const { asker, timers, errors, seen, asked } = setup([held, new Error('blip'), held, none]);
    asker.start();
    await settle();
    timers.fire();
    await settle();
    assert.equal(errors.length, 1);
    assert.deepEqual(timers.delays(), [10_000], 'retries in 10 s');
    timers.fire();
    await settle();
    timers.fire();
    await settle();
    assert.equal(asked(), 4);
    assert.equal(seen.length, 3);
    assert.equal(timers.count(), 0);
  });

  it('a restart for a reconnect that already shows a hold retries a failed ask', async () => {
    const { asker, timers } = setup([new Error('blip'), none]);
    asker.start(true);
    await settle();
    assert.deepEqual(timers.delays(), [10_000]);
  });

  it('an old media server ends the asking, even while a hold was known', async () => {
    const { asker, timers, errors } = setup([held, new HeldBroadcastUnsupportedError()]);
    asker.start();
    await settle();
    timers.fire();
    await settle();
    assert.equal(errors[0] instanceof HeldBroadcastUnsupportedError, true);
    assert.equal(timers.count(), 0);
  });

  it('can start again after it stopped', async () => {
    const { asker, asked } = setup([none]);
    asker.start();
    await settle();
    asker.start();
    await settle();
    assert.equal(asked(), 2);
  });
});

describe('fetchHeldBroadcast', () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends the room and the bearer token to the media server, and reads the answer', async () => {
    let requested: { url: string; headers: Record<string, string> } | null = null;
    const answer = await fetchHeldBroadcast({
      roomId: 'room 1',
      token: 'tok',
      mediaHttpUrl: 'https://media.example/',
      fetchImpl: (async (url: string, init: RequestInit) => {
        requested = { url, headers: init.headers as Record<string, string> };
        return new Response(JSON.stringify({ held: true, state: 'held', secondsLeft: 90, destinations: [{ name: 'YouTube', connected: true }] }));
      }) as unknown as typeof fetch,
    });
    assert.equal(requested!.url, 'https://media.example/rtmp/held?roomId=room%201');
    assert.equal(requested!.headers.Authorization, 'Bearer tok');
    assert.equal(answer.held, true);
    assert.equal(answer.secondsLeft, 90);
  });

  it('treats not found and a body that is not an answer as an old server', async () => {
    await assert.rejects(fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: respond(404, { error: 'Not found' }) }), HeldBroadcastUnsupportedError);
    await assert.rejects(fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: respond(200, { ok: true }) }), HeldBroadcastUnsupportedError);
  });

  it('gives up on a request that hangs, as an ordinary error that is retried', async () => {
    let aborted = false;
    const hanging = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as unknown as typeof fetch;
    await assert.rejects(
      fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: hanging, timeoutMs: 20 }),
      (error: unknown) => error instanceof Error && !(error instanceof HeldBroadcastUnsupportedError) && /in time/.test(error.message)
    );
    assert.equal(aborted, true, 'the request itself is cancelled');
  });

  it('a body that never finishes is a failed ask, not an old server', async () => {
    const slowBody = (async (_url: string, init: RequestInit) => ({
      status: 200,
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
    })) as unknown as typeof fetch;
    await assert.rejects(
      fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: slowBody, timeoutMs: 20 }),
      (error: unknown) => error instanceof Error && !(error instanceof HeldBroadcastUnsupportedError) && /in time/.test(error.message)
    );
  });

  it('an answer in time is returned, and the time limit cancels nothing afterwards', async () => {
    let inner: AbortSignal | null | undefined;
    const answer = await fetchHeldBroadcast({
      roomId: 'r',
      token: 't',
      mediaHttpUrl: 'https://m',
      timeoutMs: 30,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        inner = init.signal;
        return new Response(JSON.stringify({ held: false, state: 'none' }));
      }) as unknown as typeof fetch,
    });
    assert.equal(answer.held, false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(inner?.aborted, false, 'the timer was cleared with the answer');
  });

  it('lets go of the caller signal once it is done', async () => {
    const outer = new AbortController();
    let inner: AbortSignal | null | undefined;
    await fetchHeldBroadcast({
      roomId: 'r',
      token: 't',
      mediaHttpUrl: 'https://m',
      signal: outer.signal,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        inner = init.signal;
        return new Response(JSON.stringify({ held: false, state: 'none' }));
      }) as unknown as typeof fetch,
    });
    outer.abort();
    assert.equal(inner?.aborted, false, 'a later cancel from the caller does not reach the finished request');
  });

  it('passes on a cancel from the caller', async () => {
    const outer = new AbortController();
    const waiting = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    })) as unknown as typeof fetch;
    const pending = fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: waiting, signal: outer.signal });
    outer.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  });

  it('no media server address means nothing to ask, and no retry', async () => {
    await assert.rejects(fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: '  ' }), HeldBroadcastUnsupportedError);
  });

  it('reports a refusal as an ordinary error', async () => {
    await assert.rejects(
      fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: respond(401, { error: 'no' }) }),
      (error: unknown) => error instanceof Error && !(error instanceof HeldBroadcastUnsupportedError) && /401/.test(error.message)
    );
  });
});
