import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readScreenVolume, screenVolumeStorageKey, writeScreenVolume } from '../src/audio/screenVolumeStore.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe('screen volume store', () => {
  it('defaults to full volume', () => {
    assert.equal(readScreenVolume('room1', memoryStorage()), 1);
    assert.equal(readScreenVolume(undefined, memoryStorage()), 1);
    assert.equal(readScreenVolume('room1', null), 1);
  });

  it('restores what was written, per room', () => {
    const storage = memoryStorage();
    writeScreenVolume('room1', 0.4, storage);
    writeScreenVolume('room2', 0, storage);
    assert.equal(readScreenVolume('room1', storage), 0.4);
    assert.equal(readScreenVolume('room2', storage), 0);
    assert.equal(readScreenVolume('room3', storage), 1);
  });

  it('survives broken storage and junk values', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.equal(readScreenVolume('room1', broken), 1);
    assert.doesNotThrow(() => writeScreenVolume('room1', 0.3, broken));
    assert.equal(readScreenVolume('room1', memoryStorage({ [screenVolumeStorageKey('room1')]: 'abc' })), 1);
  });
});
