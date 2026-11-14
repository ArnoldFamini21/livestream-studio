import assert from 'node:assert/strict';
import test from 'node:test';

import { BUSY_ERROR, waitForIdleMedia } from './wait-for-idle-media.mjs';

// A fake clock: sleep() moves time forward, nothing really waits.
function harness(states) {
  let clock = 0;
  const logs = [];
  const sleeps = [];
  const queue = [...states];
  return {
    logs,
    sleeps,
    options: {
      budgetMs: 10 * 60_000,
      pollMs: 30_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      log: (line) => logs.push(line),
      readActivity: async () => {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return typeof next === 'string' ? { state: next, started: next === 'busy' ? 1 : 0, detail: 'test detail' } : next;
      },
    },
  };
}

test('idle on the first poll exits 0 at once, with one status line', async () => {
  const h = harness(['idle']);
  const result = await waitForIdleMedia(h.options);
  assert.deepEqual(result, { exitCode: 0, outcome: 'idle' });
  assert.equal(h.logs.length, 1);
  assert.deepEqual(h.sleeps, []);
});

test('busy then idle polls every 30 seconds and prints one line per poll', async () => {
  const h = harness(['busy', 'busy', 'idle']);
  const result = await waitForIdleMedia(h.options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(h.sleeps, [30_000, 30_000]);
  assert.equal(h.logs.length, 3);
  assert.match(h.logs[0], /busy/);
  assert.match(h.logs[2], /idle/);
});

test('still busy when the budget ends exits 1 with the plain error line', async () => {
  const h = harness(['busy']);
  const result = await waitForIdleMedia(h.options);
  assert.deepEqual(result, { exitCode: 1, outcome: 'busy' });
  assert.equal(h.logs.at(-1), BUSY_ERROR);
  assert.equal(
    BUSY_ERROR,
    '::error::A broadcast or a private test is on the air. Nothing was deployed. Re-run this workflow when it has ended.'
  );
  // 10 minutes at 30 s: polls at 0, 30, ..., 600 s = 21 polls, 20 sleeps, the last poll lands on the budget.
  assert.equal(h.sleeps.length, 20);
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 10 * 60_000);
  assert.equal(h.logs.filter((line) => line.includes('busy')).length, 21);
});

test('the last sleep is shortened so a poll lands exactly on the budget', async () => {
  const h = harness(['busy']);
  h.options.budgetMs = 45_000;
  await waitForIdleMedia(h.options);
  assert.deepEqual(h.sleeps, [30_000, 15_000]);
});

test('an unreachable media server is treated as idle, with a warning', async () => {
  const h = harness(['unreachable']);
  const result = await waitForIdleMedia(h.options);
  assert.deepEqual(result, { exitCode: 0, outcome: 'unreachable' });
  assert.ok(h.logs.some((line) => line.startsWith('::warning::') && line.includes('no broadcast to protect')));
});

test('an unknown answer proceeds with a warning', async () => {
  const h = harness(['unknown']);
  const result = await waitForIdleMedia(h.options);
  assert.deepEqual(result, { exitCode: 0, outcome: 'unknown' });
  assert.ok(h.logs.some((line) => line.startsWith('::warning::') && line.includes('test detail')));
});

test('a server that goes down while a broadcast was running lets the deploy go on', async () => {
  const h = harness(['busy', 'unreachable']);
  const result = await waitForIdleMedia(h.options);
  assert.equal(result.outcome, 'unreachable');
  assert.equal(result.exitCode, 0);
});
