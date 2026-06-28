import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyStageItemOrder,
  moveStageItemInOrder,
  normalizeStageItemOrder,
  reorderStageItemBefore,
} from '../src/utils/stageItemOrder.ts';

const items = [
  { id: 'host', name: 'Host' },
  { id: 'guest-1', name: 'Guest 1' },
  { id: 'guest-2', name: 'Guest 2' },
  { id: 'screen', name: 'Screen' },
];

describe('stage item ordering', () => {
  it('normalizes saved order against currently available stage items', () => {
    assert.deepEqual(
      normalizeStageItemOrder(['missing', 'guest-2', 'guest-2', 'host'], items.map((item) => item.id)),
      ['guest-2', 'host', 'guest-1', 'screen']
    );
  });

  it('orders stage items and keeps a focused tile first', () => {
    assert.deepEqual(
      applyStageItemOrder(items, ['guest-1', 'host', 'guest-2', 'screen']).map((item) => item.id),
      ['guest-1', 'host', 'guest-2', 'screen']
    );
    assert.deepEqual(
      applyStageItemOrder(items, ['guest-1', 'host', 'guest-2', 'screen'], 'guest-2').map((item) => item.id),
      ['guest-2', 'guest-1', 'host', 'screen']
    );
  });

  it('moves a stage item left, right, or to the front without losing missing items', () => {
    const availableIds = items.map((item) => item.id);
    assert.deepEqual(
      moveStageItemInOrder(['host', 'guest-1', 'guest-2'], availableIds, 'guest-2', 'left'),
      ['host', 'guest-2', 'guest-1', 'screen']
    );
    assert.deepEqual(
      moveStageItemInOrder(['host', 'guest-1', 'guest-2'], availableIds, 'host', 'right'),
      ['guest-1', 'host', 'guest-2', 'screen']
    );
    assert.deepEqual(
      moveStageItemInOrder(['host', 'guest-1', 'guest-2'], availableIds, 'guest-2', 'first'),
      ['guest-2', 'host', 'guest-1', 'screen']
    );
  });

  it('reorders a dragged stage item before a drop target', () => {
    const availableIds = items.map((item) => item.id);
    assert.deepEqual(
      reorderStageItemBefore(['host', 'guest-1', 'guest-2'], availableIds, 'guest-2', 'host'),
      ['guest-2', 'host', 'guest-1', 'screen']
    );
    assert.deepEqual(
      reorderStageItemBefore(['host', 'guest-1', 'guest-2'], availableIds, 'host', 'guest-2'),
      ['guest-1', 'host', 'guest-2', 'screen']
    );
  });

  it('keeps normalized order for no-op or invalid drag drops', () => {
    const availableIds = items.map((item) => item.id);
    assert.deepEqual(
      reorderStageItemBefore(['host', 'guest-1'], availableIds, 'host', 'host'),
      ['host', 'guest-1', 'guest-2', 'screen']
    );
    assert.deepEqual(
      reorderStageItemBefore(['host', 'guest-1'], availableIds, 'missing', 'host'),
      ['host', 'guest-1', 'guest-2', 'screen']
    );
    assert.deepEqual(
      reorderStageItemBefore(['host', 'guest-1'], availableIds, 'host', 'missing'),
      ['host', 'guest-1', 'guest-2', 'screen']
    );
  });
});
