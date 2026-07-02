import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutMode } from '@studio/shared';
import {
  getMediaShareLayoutPlan,
  mergeSharedMediaParticipantItems,
  selectVisibleStageItems,
} from '../src/utils/mediaShareLayouts.ts';

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

  it('prepends a presenter fallback when shared media would otherwise hide the host', () => {
    const stageItems: Array<{ id: string; name: string }> = [];
    const presenterItems = [{ id: 'host', name: 'Host' }];

    assert.deepEqual(mergeSharedMediaParticipantItems(stageItems, presenterItems), presenterItems);
  });

  it('keeps existing stage order and does not duplicate the presenter fallback', () => {
    const stageItems = [
      { id: 'host', name: 'Host' },
      { id: 'guest', name: 'Guest' },
    ];
    const presenterItems = [{ id: 'host', name: 'Host fallback' }];

    assert.deepEqual(mergeSharedMediaParticipantItems(stageItems, presenterItems), stageItems);
  });

  it('can add camera and screen fallbacks for a local screen share', () => {
    const stageItems = [{ id: 'guest', name: 'Guest' }];
    const presenterItems = [
      { id: 'host', name: 'Host camera' },
      { id: 'host-screen', name: 'Host screen' },
    ];

    assert.deepEqual(
      mergeSharedMediaParticipantItems(stageItems, presenterItems, 2).map((item) => item.id),
      ['host', 'host-screen', 'guest']
    );
  });

  it('renders every stage item when a screen share is active even if the selected layout normally clips tiles', () => {
    const stageItems = ['camera', 'screen', 'guest'];

    assert.deepEqual(selectVisibleStageItems(stageItems, 'single', { hasScreenShare: true }), stageItems);
    assert.deepEqual(selectVisibleStageItems(stageItems, 'pip', { hasScreenShare: true }), stageItems);
  });

  it('still limits participant tiles when uploaded media defines a visible participant cap', () => {
    const stageItems = ['host', 'guest-1', 'guest-2'];

    assert.deepEqual(
      selectVisibleStageItems(stageItems, 'grid', { mediaVisibleParticipantCount: 1, hasScreenShare: true }),
      ['host']
    );
  });
});
