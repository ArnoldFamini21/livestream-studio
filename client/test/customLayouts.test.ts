import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CustomLayout, CustomLayoutSlot } from '@studio/shared';
import {
  addCustomLayoutSlot,
  assignCustomLayoutSlots,
  createCustomLayoutFromTemplate,
  CUSTOM_LAYOUT_TEMPLATES,
  duplicateCustomLayout,
  duplicateCustomLayoutSlot,
  getCustomStagePlan,
  MAX_CUSTOM_LAYOUT_SLOTS,
  MAX_CUSTOM_LAYOUTS,
  moveCustomLayoutSlot,
  nudgeCustomLayoutSlot,
  orderStageEntriesByIds,
  removeCustomLayoutSlot,
  resizeCustomLayoutSlot,
  restackCustomLayoutSlot,
  snapCustomLayoutValue,
  updateCustomLayoutSlot,
  upsertCustomLayout,
} from '../src/utils/customLayouts.ts';

function slot(id: string, x: number, y: number, w: number, h: number, extra: Partial<CustomLayoutSlot> = {}): CustomLayoutSlot {
  return { id, x, y, w, h, z: 0, shape: 'rect', kind: 'camera', ...extra };
}

function layoutOf(slots: CustomLayoutSlot[], orientation: CustomLayout['orientation'] = 'landscape'): CustomLayout {
  return { id: 'layout-1', name: 'Test', orientation, slots };
}

// Slots are stored to four decimals.
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ≈ ${expected}`);

describe('custom layout templates', () => {
  it('builds every starter template for both orientations, inside the canvas', () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      for (const template of CUSTOM_LAYOUT_TEMPLATES) {
        const layout = createCustomLayoutFromTemplate(template.id, orientation, [], `layout-${template.id}`);
        assert.equal(layout.orientation, orientation);
        assert.ok(layout.slots.length >= 2);
        for (const item of layout.slots) {
          assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= 1 + 1e-9 && item.y + item.h <= 1 + 1e-9, `${template.id} ${item.id}`);
        }
      }
    }
    const content = createCustomLayoutFromTemplate('content-two-cameras', 'landscape', [], 'c');
    assert.deepEqual(content.slots.map((item) => item.kind), ['content', 'camera', 'camera']);
  });

  it('keeps the picture-in-picture circle round on screen', () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      const pip = createCustomLayoutFromTemplate('picture-in-picture', orientation, [], 'p');
      const circle = pip.slots.find((item) => item.shape === 'circle')!;
      const canvas = orientation === 'portrait' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
      assert.ok(Math.abs(circle.w * canvas.w - circle.h * canvas.h) < 2);
      assert.ok(circle.z > pip.slots[0].z, 'the small camera sits above the full one');
    }
  });

  it('names copies uniquely and duplicates layouts with new ids', () => {
    const first = createCustomLayoutFromTemplate('three-up', 'landscape', [], 'a');
    const second = createCustomLayoutFromTemplate('three-up', 'landscape', [first.name], 'b');
    assert.equal(second.name, '3-up 2');
    const copy = duplicateCustomLayout(first, [first.name, second.name], 'copy');
    assert.equal(copy.id, 'copy');
    assert.equal(copy.name, '3-up copy');
    assert.notEqual(copy.slots[0], first.slots[0]);
  });
});

describe('custom layout slot assignment', () => {
  const layout = layoutOf([
    slot('a', 0, 0, 0.5, 1),
    slot('content', 0.5, 0, 0.5, 0.5, { kind: 'content' }),
    slot('b', 0.5, 0.5, 0.25, 0.5, { participantId: 'guest' }),
    slot('c', 0.75, 0.5, 0.25, 0.5),
  ]);

  it('fills camera slots in stage order, honouring pins', () => {
    assert.deepEqual(assignCustomLayoutSlots(layout, ['host', 'guest', 'cohost']), [
      { slotId: 'a', itemId: 'host' },
      { slotId: 'b', itemId: 'guest' },
      { slotId: 'c', itemId: 'cohost' },
    ]);
    // The pinned guest keeps slot b even when first in stage order.
    assert.deepEqual(assignCustomLayoutSlots(layout, ['guest', 'host']), [
      { slotId: 'b', itemId: 'guest' },
      { slotId: 'a', itemId: 'host' },
    ]);
  });

  it('gives a pinned slot to the next person when the pinned one is not on stage, and drops extras', () => {
    assert.deepEqual(assignCustomLayoutSlots(layout, ['host', 'x', 'y', 'z']), [
      { slotId: 'a', itemId: 'host' },
      { slotId: 'b', itemId: 'x' },
      { slotId: 'c', itemId: 'y' },
    ]);
  });

  it('renders absolutely positioned tiles aligned with the item order, plus the content box', () => {
    const plan = getCustomStagePlan(layout, ['host', 'guest']);
    assert.deepEqual(plan.itemOrder, ['host', 'guest']);
    assert.equal(plan.tileStyles.length, 2);
    assert.equal(plan.tileStyles[0].position, 'absolute');
    assert.equal(plan.tileStyles[0].left, '0%');
    assert.equal(plan.tileStyles[0].width, '50%');
    assert.equal(plan.tileStyles[1].left, '50%');
    assert.equal(plan.tileStyles[1].top, '50%');
    assert.equal(plan.contentStyle?.width, '50%');
    assert.equal(plan.contentStyle?.height, '50%');
    const entries = [{ item: { id: 'guest' } }, { item: { id: 'host' } }, { item: { id: 'extra' } }];
    assert.deepEqual(orderStageEntriesByIds(entries, plan.itemOrder, (entry) => entry.item.id).map((entry) => entry.item.id), ['host', 'guest']);
  });

  it('mirrors slot shapes as tile corner radii', () => {
    const shapes = getCustomStagePlan(layoutOf([
      slot('r', 0, 0, 0.3, 0.3),
      slot('o', 0.3, 0, 0.3, 0.3, { shape: 'rounded' }),
      slot('c', 0.6, 0, 0.3, 0.3, { shape: 'circle' }),
    ]), ['1', '2', '3']).tileStyles.map((style) => style.borderRadius);
    assert.deepEqual(shapes, [0, 16, '50%']);
  });
});

describe('custom layout editing', () => {
  it('snaps to guides first, then to the grid, and can place freely', () => {
    assert.deepEqual(snapCustomLayoutValue(0.493, [0.5]), { value: 0.5, guide: 0.5 });
    close(snapCustomLayoutValue(0.311, []).value, 0.3);
    assert.deepEqual(snapCustomLayoutValue(0.311, [], { grid: false, guides: false }), { value: 0.311, guide: null });
  });

  it('moves a slot, snapping its edge or centre to other slots and the canvas centre', () => {
    const other = slot('o', 0.62, 0.2, 0.3, 0.3);
    const moved = moveCustomLayoutSlot(slot('a', 0.1, 0.1, 0.2, 0.2), 0.316, 0.004, [other]);
    // The right edge (0.616) snaps to the other's left edge (0.62).
    close(moved.slot.x, 0.42);
    assert.deepEqual(moved.guidesX, [0.62]);
    const centred = moveCustomLayoutSlot(slot('a', 0.1, 0.1, 0.2, 0.2), 0.305, 0, []);
    close(centred.slot.x + centred.slot.w / 2, 0.5);
  });

  it('keeps a moved slot inside the canvas', () => {
    const moved = moveCustomLayoutSlot(slot('a', 0.7, 0.7, 0.2, 0.2), 0.5, 0.5, []);
    close(moved.slot.x, 0.8);
    close(moved.slot.y, 0.8);
  });

  it('resizes from any handle, never below the minimum or past the edges', () => {
    const start = slot('a', 0.2, 0.2, 0.4, 0.4);
    const grown = resizeCustomLayoutSlot(start, 'se', 0.3, 0.3, [], 'landscape').slot;
    close(grown.x, 0.2);
    close(grown.w, 0.7);
    close(grown.h, 0.7);
    const shrunk = resizeCustomLayoutSlot(start, 'nw', 0.5, 0.5, [], 'landscape').slot;
    assert.ok(shrunk.w >= 0.04 && shrunk.h >= 0.04);
    close(shrunk.x + shrunk.w, 0.6);
    const past = resizeCustomLayoutSlot(start, 'w', -0.5, 0, [], 'landscape').slot;
    close(past.x, 0);
  });

  it('keeps circles square on screen while resizing', () => {
    const circle = slot('c', 0.1, 0.1, 0.2, 0.2 * 16 / 9, { shape: 'circle' });
    const resized = resizeCustomLayoutSlot(circle, 'e', 0.1, 0, [], 'landscape').slot;
    close(resized.h, resized.w * 16 / 9);
    const portrait = resizeCustomLayoutSlot(slot('p', 0.1, 0.1, 0.3, 0.3 * 9 / 16, { shape: 'circle' }), 's', 0, 0.1, [], 'portrait').slot;
    close(portrait.h, portrait.w * 9 / 16);
  });

  it('nudges with the arrow keys, by a grid step with Shift', () => {
    const start = slot('a', 0.2, 0.2, 0.2, 0.2);
    close(nudgeCustomLayoutSlot(start, 'ArrowRight', false)!.x, 0.205);
    close(nudgeCustomLayoutSlot(start, 'ArrowUp', true)!.y, 0.175);
    assert.equal(nudgeCustomLayoutSlot(start, 'Enter', false), null);
  });

  it('adds, duplicates, removes and restacks slots within the limits', () => {
    let layout = layoutOf([slot('a', 0, 0, 0.5, 0.5)]);
    const added = addCustomLayoutSlot(layout, 'content')!;
    layout = added.layout;
    assert.equal(layout.slots.find((item) => item.id === added.slotId)?.kind, 'content');
    assert.equal(addCustomLayoutSlot(layout, 'content'), null, 'one content box per layout');
    const copy = duplicateCustomLayoutSlot(layout, 'a')!;
    assert.ok(copy.layout.slots.find((item) => item.id === copy.slotId)!.z > 0);
    while (layout.slots.length < MAX_CUSTOM_LAYOUT_SLOTS) layout = addCustomLayoutSlot(layout, 'camera')!.layout;
    assert.equal(addCustomLayoutSlot(layout, 'camera'), null);
    assert.equal(removeCustomLayoutSlot(layoutOf([slot('only', 0, 0, 1, 1)]), 'only').slots.length, 1, 'a layout keeps one box');
    const stacked = restackCustomLayoutSlot(layoutOf([slot('a', 0, 0, 1, 1, { z: 0 }), slot('b', 0, 0, 1, 1, { z: 1 })]), 'a', 'front');
    assert.ok(stacked.slots.find((item) => item.id === 'a')!.z > stacked.slots.find((item) => item.id === 'b')!.z);
  });

  it('turns a box into a circle by squaring it, and clears pins on content boxes', () => {
    const layout = layoutOf([slot('a', 0, 0, 0.5, 0.5, { participantId: 'p' })]);
    const circle = updateCustomLayoutSlot(layout, 'a', { shape: 'circle' }).slots[0];
    close(circle.h, circle.w * 16 / 9);
    const content = updateCustomLayoutSlot(layout, 'a', { kind: 'content' }).slots[0];
    assert.equal(content.participantId, undefined);
    assert.equal(updateCustomLayoutSlot(layout, 'a', { participantId: null }).slots[0].participantId, undefined);
  });

  it('saves layouts by id, newest first, bounded', () => {
    let layouts: CustomLayout[] = [];
    for (let index = 0; index < MAX_CUSTOM_LAYOUTS + 2; index += 1) {
      layouts = upsertCustomLayout(layouts, { ...layoutOf([slot('a', 0, 0, 1, 1)]), id: `l${index}`, name: `L${index}` });
    }
    assert.equal(layouts.length, MAX_CUSTOM_LAYOUTS);
    assert.equal(layouts[0].id, `l${MAX_CUSTOM_LAYOUTS + 1}`);
    const renamed = upsertCustomLayout(layouts, { ...layouts[3], name: 'Renamed' });
    assert.equal(renamed[3].name, 'Renamed');
    assert.equal(renamed.length, layouts.length);
  });
});
