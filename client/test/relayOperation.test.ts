import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isRelayOperationCancelled,
  RelayOperation,
  RelayOperationSlot,
  startAuthorizedRelay,
  watchRelayStartup,
} from '../src/utils/relayOperation.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('live relay operation cancellation', () => {
  for (const phase of ['initial authorization', 'reconnect authorization']) {
    it(`does not open a relay when Stop precedes delayed ${phase}`, async () => {
      const operation = new RelayOperation();
      const token = deferred<string>();
      const events: string[] = [];
      const pending = startAuthorizedRelay(operation, () => token.promise,
        async () => { events.push('socket-opened'); }, () => events.push('live:true'));
      const canceled = assert.rejects(pending, isRelayOperationCancelled);

      operation.cancel();
      await canceled; // Stop settles immediately, even if authorization never answers.
      token.resolve('late-token');
      await flush();

      assert.deepEqual(events, []);
    });
  }

  it('does not authorize or update live state after delayed readiness finishes for a canceled start', async () => {
    const operation = new RelayOperation();
    const readiness = deferred<void>();
    const events: string[] = [];
    const pending = (async () => {
      await operation.run(() => readiness.promise);
      await startAuthorizedRelay(operation, async () => { events.push('authorize'); return 'token'; },
        async () => { events.push('socket-opened'); });
    })();
    const canceled = assert.rejects(pending, isRelayOperationCancelled);

    operation.cancel();
    readiness.resolve();
    await canceled;

    assert.deepEqual(events, []);
  });

  it('releases a mixer that finishes after Stop without attaching it or opening a socket', async () => {
    const operation = new RelayOperation();
    const mixing = deferred<{ id: string }>();
    const released: string[] = [];
    const events: string[] = [];
    const pending = (async () => {
      await operation.run(() => mixing.promise, (mixer) => released.push(mixer.id));
      operation.assertActive();
      events.push('mixer-attached', 'socket-opened');
    })();
    const canceled = assert.rejects(pending, isRelayOperationCancelled);

    operation.cancel();
    await canceled;
    mixing.resolve({ id: 'old-mixer' });
    await flush();

    assert.deepEqual(released, ['old-mixer']);
    assert.deepEqual(events, []);
  });

  it('keeps a newer broadcast running when an older authorization later rejects', async () => {
    const first = new RelayOperation();
    const firstToken = deferred<string>();
    const events: string[] = [];
    const firstStart = startAuthorizedRelay(first, () => firstToken.promise,
      async () => { events.push('first-started'); });
    const canceled = assert.rejects(firstStart, isRelayOperationCancelled);
    first.cancel();

    const second = new RelayOperation();
    await startAuthorizedRelay(second, async () => 'new-token',
      async () => { events.push('second-started'); }, () => events.push('live:true'));
    firstToken.reject(new Error('old authorization failed'));
    await canceled;
    await flush();

    assert.equal(second.active, true);
    assert.deepEqual(events, ['second-started', 'live:true']);
  });

  it('settles a canceled handshake promptly and prevents its startup completion signal', async () => {
    const operation = new RelayOperation();
    const handshake = deferred<void>();
    let watchdogArmed = false;
    const events: string[] = [];
    const pending = startAuthorizedRelay(operation, async () => 'token', () => {
      watchdogArmed = true;
      operation.signal.addEventListener('abort', () => { watchdogArmed = false; }, { once: true });
      return handshake.promise;
    }, () => events.push('live:true'));
    const canceled = assert.rejects(pending, isRelayOperationCancelled);
    await flush();
    assert.equal(watchdogArmed, true);

    operation.cancel();
    await canceled;
    handshake.resolve();
    await flush();

    assert.equal(watchdogArmed, false);
    assert.deepEqual(events, []);
  });

  it('supports ordinary authorization and startup in order', async () => {
    const operation = new RelayOperation();
    const events: string[] = [];

    await startAuthorizedRelay(operation, async () => { events.push('authorize'); return 'token'; },
      async (token) => { events.push(`start:${token}`); }, () => events.push('live:true'));

    assert.deepEqual(events, ['authorize', 'start:token', 'live:true']);
  });

  it('reports genuine current-session failures without treating them as cancellation', async () => {
    const operation = new RelayOperation();
    const failure = new Error('destination rejected startup');

    await assert.rejects(startAuthorizedRelay(operation, async () => 'token', async () => { throw failure; }),
      (error) => error === failure && !isRelayOperationCancelled(error));
  });

  it('never executes a new task on an operation that has already been stopped', async () => {
    const operation = new RelayOperation();
    operation.cancel();
    let called = false;

    await assert.rejects(operation.run(async () => { called = true; }), isRelayOperationCancelled);
    assert.equal(called, false);
  });

  it('rejects duplicate starts while the first attempt is still preparing', () => {
    const slot = new RelayOperationSlot();
    assert.ok(slot.begin());
    assert.equal(slot.begin(), null);
  });

  it('does not release a new attempt when an old canceled startup finishes', () => {
    const slot = new RelayOperationSlot();
    const first = slot.begin()!;
    slot.cancel();
    const second = slot.begin()!;

    slot.finish(first);

    assert.equal(second.active, true);
    assert.equal(slot.active, true);
    slot.finish(second);
    assert.equal(slot.active, false);
  });
});

describe('relay startup watchdog ownership', () => {
  it('clears an old handshake watchdog on Stop and ignores even an already queued timeout', () => {
    const old = new RelayOperation();
    const events: string[] = [];
    let timeout!: () => void;
    watchRelayStartup(old, {
      timeoutMs: 12_000,
      schedule: (callback) => { timeout = callback; return () => { events.push('timer-cleared'); }; },
      onTimeout: () => events.push('stop-transport'),
      onCancel: () => events.push('handshake-canceled'),
    });

    old.cancel();
    const current = new RelayOperation();
    timeout();

    assert.equal(current.active, true);
    assert.deepEqual(events, ['timer-cleared', 'handshake-canceled']);
  });

  it('disarms the timeout and cancellation listener once the handshake succeeds', () => {
    const operation = new RelayOperation();
    const events: string[] = [];
    let timeout!: () => void;
    const finish = watchRelayStartup(operation, {
      timeoutMs: 12_000,
      schedule: (callback) => { timeout = callback; return () => { events.push('timer-cleared'); }; },
      onTimeout: () => events.push('timed-out'),
      onCancel: () => events.push('canceled'),
    });

    finish();
    timeout();
    operation.cancel();

    assert.deepEqual(events, ['timer-cleared']);
  });

  it('reports a real current-session timeout once', () => {
    const operation = new RelayOperation();
    const events: string[] = [];
    let timeout!: () => void;
    watchRelayStartup(operation, {
      timeoutMs: 12_000,
      schedule: (callback) => { timeout = callback; return () => {}; },
      onTimeout: () => events.push('timed-out'),
      onCancel: () => events.push('canceled'),
    });

    timeout();
    timeout();
    operation.cancel();

    assert.deepEqual(events, ['timed-out']);
  });
});
