import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getWatchVoterId, pollOptionPercent, readWatchPollChoice, saveWatchPollChoice } from '../src/utils/watchPollVoting.ts';

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}

describe('watch poll voting helpers', () => {
  it('keeps one random voter id per browser', () => {
    const storage = memoryStorage();
    const id = getWatchVoterId(storage);
    assert.match(id, /^[a-f0-9]{36}$/);
    assert.equal(getWatchVoterId(storage), id);
    assert.notEqual(getWatchVoterId(memoryStorage()), id);
  });

  it('still works when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.match(getWatchVoterId(blocked), /^[a-f0-9]{36}$/);
    assert.equal(readWatchPollChoice('p', blocked), null);
    saveWatchPollChoice('p', 'a', blocked);
  });

  it('remembers the choice per poll and computes percentages', () => {
    const storage = memoryStorage();
    saveWatchPollChoice('poll-1', 'b', storage);
    assert.equal(readWatchPollChoice('poll-1', storage), 'b');
    assert.equal(readWatchPollChoice('poll-2', storage), null);
    const poll = { id: 'p', question: 'q', status: 'open' as const, totalVotes: 3, options: [{ id: 'a', text: 'A', votes: 1 }, { id: 'b', text: 'B', votes: 2 }] };
    assert.equal(pollOptionPercent(poll, 'a'), 33);
    assert.equal(pollOptionPercent(poll, 'b'), 67);
    assert.equal(pollOptionPercent({ ...poll, totalVotes: 0 }, 'a'), 0);
  });
});
