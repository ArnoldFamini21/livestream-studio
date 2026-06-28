import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LAYOUT_SWITCH_TRANSITION_DURATION_MS,
  getStageLayoutTransitionStyle,
  shouldStartLayoutTransition,
} from '../src/utils/layoutTransitions.ts';

describe('layout transitions', () => {
  it('runs only when the layout changes', () => {
    assert.equal(shouldStartLayoutTransition('grid', 'grid'), false);
    assert.equal(shouldStartLayoutTransition('grid', 'spotlight'), true);
  });

  it('returns no stage style when there is no active transition', () => {
    assert.deepEqual(getStageLayoutTransitionStyle(null), {});
  });

  it('builds bounded entry and settled styles for smooth switching', () => {
    const entry = getStageLayoutTransitionStyle({ visible: false });
    const settled = getStageLayoutTransitionStyle({ visible: true });

    assert.equal(entry.opacity, 0.84);
    assert.equal(entry.transform, 'scale(0.985)');
    assert.equal(settled.opacity, 1);
    assert.equal(settled.transform, 'scale(1)');
    assert.match(String(settled.transition), new RegExp(`${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms`));
    assert.equal(settled.willChange, 'opacity, transform');
  });
});
