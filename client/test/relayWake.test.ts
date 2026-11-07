import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatRelayWakeMessage, probeUntilAwake } from '../src/utils/relayWake.ts';

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

describe('waking the media relay before Go Live', () => {
  it('keeps probing while the media server wakes, reporting progress', async () => {
    let calls = 0;
    const waiting: number[] = [];
    await probeUntilAwake(async () => {
      calls += 1;
      if (calls < 4) throw new Error('Media relay did not respond in time.');
    }, { ...clock(), intervalMs: 3_000, onWaiting: (elapsed) => waiting.push(elapsed) });
    assert.equal(calls, 4);
    assert.deepEqual(waiting, [0, 3_000, 6_000]);
  });

  it('gives up after about ninety seconds with the last error', async () => {
    let calls = 0;
    await assert.rejects(
      () => probeUntilAwake(async () => { calls += 1; throw new Error('still asleep'); }, { ...clock(), timeoutMs: 90_000, intervalMs: 3_000 }),
      /still asleep/
    );
    assert.equal(calls, 30);
  });

  it('stops when a newer check replaces it', async () => {
    let calls = 0;
    let active = true;
    await assert.rejects(() => probeUntilAwake(async () => {
      calls += 1;
      active = false;
      throw new Error('asleep');
    }, { ...clock(), shouldContinue: () => active }));
    assert.equal(calls, 1);
  });

  it('explains the wait to the host', () => {
    assert.match(formatRelayWakeMessage(12_400), /Waking up the media server.*12s/);
  });
});
