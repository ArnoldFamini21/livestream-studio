import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readMirrorSelfView, selfViewTransform, setMirrorSelfView } from '../src/utils/selfViewMirror.ts';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

describe('self-view mirror preference', () => {
  it('mirrors by default and remembers the true view', () => {
    const storage = memoryStorage();
    assert.equal(readMirrorSelfView(storage), true);
    setMirrorSelfView(false, storage);
    assert.equal(readMirrorSelfView(storage), false);
    setMirrorSelfView(true, storage);
    assert.equal(readMirrorSelfView(storage), true);
  });

  it('falls back to mirrored when storage is unavailable', () => {
    assert.equal(readMirrorSelfView(undefined), true);
    assert.equal(readMirrorSelfView({ getItem: () => { throw new Error('blocked'); } }), true);
  });

  it('maps the preference to a transform', () => {
    assert.equal(selfViewTransform(true), 'scaleX(-1)');
    assert.equal(selfViewTransform(false), 'none');
  });
});
