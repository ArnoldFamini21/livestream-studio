import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutMode } from '@studio/shared';
import { getMediaShareLayoutPlan } from '../src/utils/mediaShareLayouts.ts';

describe('media share layouts', () => {
  it('keeps a participant visible for every layout while media is active', () => {
    const layouts: LayoutMode[] = ['grid', 'spotlight', 'side-by-side', 'pip', 'single', 'featured'];

    for (const layout of layouts) {
      const plan = getMediaShareLayoutPlan(layout, 1);

      assert.equal(plan.visibleParticipantCount, 1);
    }
  });

  it('uses StreamYard-style participant placements for shared media formats', () => {
    assert.equal(getMediaShareLayoutPlan('grid', 3).placement, 'side-rail');
    assert.equal(getMediaShareLayoutPlan('featured', 3).placement, 'side-rail');
    assert.equal(getMediaShareLayoutPlan('spotlight', 3).placement, 'bottom-strip');
    assert.equal(getMediaShareLayoutPlan('side-by-side', 3).placement, 'side-by-side');
    assert.equal(getMediaShareLayoutPlan('pip', 3).placement, 'pip');
    assert.equal(getMediaShareLayoutPlan('single', 3).placement, 'pip');
  });

  it('caps participant rails so the shared file remains readable', () => {
    assert.equal(getMediaShareLayoutPlan('grid', 12).visibleParticipantCount, 4);
    assert.equal(getMediaShareLayoutPlan('featured', 12).visibleParticipantCount, 4);
    assert.equal(getMediaShareLayoutPlan('spotlight', 12).visibleParticipantCount, 6);
    assert.equal(getMediaShareLayoutPlan('side-by-side', 12).visibleParticipantCount, 1);
    assert.equal(getMediaShareLayoutPlan('pip', 12).visibleParticipantCount, 1);
  });

  it('does not invent participant tiles when media is the only stage item', () => {
    const plan = getMediaShareLayoutPlan('grid', 0);

    assert.equal(plan.visibleParticipantCount, 0);
    assert.equal(plan.mediaIsDominant, true);
    assert.equal(plan.usesFloatingParticipant, false);
  });
});
