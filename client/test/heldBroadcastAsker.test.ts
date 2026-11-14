import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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

  it('a failed first ask is reported and not retried', async () => {
    const { asker, timers, errors, asked } = setup([new Error('offline')]);
    asker.start();
    await settle();
    assert.equal(errors.length, 1);
    assert.equal(timers.count(), 0);
    assert.equal(asked(), 1);
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

  it('reports a refusal as an ordinary error', async () => {
    await assert.rejects(
      fetchHeldBroadcast({ roomId: 'r', token: 't', mediaHttpUrl: 'https://m', fetchImpl: respond(401, { error: 'no' }) }),
      (error: unknown) => error instanceof Error && !(error instanceof HeldBroadcastUnsupportedError) && /401/.test(error.message)
    );
  });
});
