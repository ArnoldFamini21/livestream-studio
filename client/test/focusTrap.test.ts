import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getWrappedFocusIndex } from '../src/utils/focusTrap.ts';

describe('dialog focus trap', () => {
  it('wraps Tab from the last control to the first and back', () => {
    assert.equal(getWrappedFocusIndex(2, 3, false), 0);
    assert.equal(getWrappedFocusIndex(0, 3, true), 2);
  });

  it('lets Tab move normally between the first and last control', () => {
    assert.equal(getWrappedFocusIndex(0, 3, false), null);
    assert.equal(getWrappedFocusIndex(2, 3, true), null);
  });

  it('pulls focus that escaped the dialog back inside', () => {
    assert.equal(getWrappedFocusIndex(-1, 3, false), 0);
    assert.equal(getWrappedFocusIndex(-1, 3, true), 2);
    assert.equal(getWrappedFocusIndex(-1, 0, false), null);
  });
});
