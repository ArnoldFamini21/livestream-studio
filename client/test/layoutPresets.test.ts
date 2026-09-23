import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutMode } from '@studio/shared';
import {
  getMediaShareLayoutDescription,
  getAutoGridColumnCount,
  getMediaShareLayoutLabel,
  getStudioLayoutDescription,
  getStudioLayoutLabel,
  isMultiParticipantLayout,
  getPresentingView,
  getPresentingViewLayout,
  isPresentingViewDisabled,
  MEDIA_SHARE_LAYOUT_ORDER,
  normalizeMediaShareLayout,
  PRESENTING_VIEW_LABELS,
  PRESENTING_VIEWS,
  STUDIO_LAYOUT_PRESET_ORDER,
} from '../src/utils/layoutPresets.ts';

const allLayouts: LayoutMode[] = ['grid', 'spotlight', 'side-by-side', 'pip', 'single', 'featured'];

describe('studio layout presets', () => {
  it('exposes the parity preset order followed by the legacy featured layout', () => {
    assert.deepEqual(STUDIO_LAYOUT_PRESET_ORDER, ['grid', 'spotlight', 'side-by-side', 'pip', 'single', 'featured']);
    assert.equal(new Set(STUDIO_LAYOUT_PRESET_ORDER).size, allLayouts.length);
  });

  it('uses StreamYard-style preset labels for the core layouts', () => {
    assert.equal(getStudioLayoutLabel('grid'), 'Grid');
    assert.equal(getStudioLayoutLabel('spotlight'), 'Spotlight');
    assert.equal(getStudioLayoutLabel('side-by-side'), 'Side by Side');
    assert.equal(getStudioLayoutLabel('pip'), 'PiP');
    assert.equal(getStudioLayoutLabel('single'), 'Solo');
    assert.equal(getStudioLayoutLabel('featured'), 'Featured');
  });

  it('marks only multi-tile presets as requiring multiple participants', () => {
    assert.equal(isMultiParticipantLayout('grid'), false);
    assert.equal(isMultiParticipantLayout('single'), false);
    assert.equal(isMultiParticipantLayout('spotlight'), true);
    assert.equal(isMultiParticipantLayout('side-by-side'), true);
    assert.equal(isMultiParticipantLayout('pip'), true);
    assert.equal(isMultiParticipantLayout('featured'), true);
  });

  it('provides concise descriptions for every preset', () => {
    for (const layout of allLayouts) {
      assert.ok(getStudioLayoutDescription(layout).length > 5);
    }
  });

  it('uses media-specific labels and descriptions when shared content is on stage', () => {
    assert.equal(getMediaShareLayoutLabel('grid'), 'Beside');
    assert.equal(getMediaShareLayoutLabel('spotlight'), 'Below');
    assert.equal(getMediaShareLayoutLabel('side-by-side'), 'Split');
    assert.equal(getMediaShareLayoutLabel('featured'), 'Stack');
    assert.match(getMediaShareLayoutDescription('side-by-side'), /up to 2 participant videos/);
    assert.match(getMediaShareLayoutDescription('featured'), /stacked floating participant videos/);
    assert.match(getMediaShareLayoutDescription('pip'), /up to 4 floating participant videos/);
  });
});

it('gives a solo host the full grid width and scales for additional guests', () => {
  assert.equal(getAutoGridColumnCount(1), 1);
  assert.deepEqual([2, 4, 5, 9, 10, 12].map(getAutoGridColumnCount), [2, 2, 3, 3, 4, 4]);
  assert.equal(getAutoGridColumnCount(0), 1);
  assert.equal(getAutoGridColumnCount(NaN), 1);
});

describe('presenting views', () => {
  it('offers Me, Content, and Content + Me, in that order', () => {
    assert.deepEqual(PRESENTING_VIEWS, ['me', 'content', 'content-me']);
    assert.deepEqual(PRESENTING_VIEWS.map((view) => PRESENTING_VIEW_LABELS[view]), ['Me', 'Content', 'Content + Me']);
  });

  it('maps views to content layouts and back', () => {
    assert.equal(getPresentingViewLayout('content'), 'single');
    assert.equal(getPresentingViewLayout('content-me'), 'grid');
    assert.equal(getPresentingViewLayout('me'), null);
    assert.equal(getPresentingView(true, 'single'), 'me');
    assert.equal(getPresentingView(false, 'single'), 'content');
    assert.equal(getPresentingView(false, 'grid'), 'content-me');
  });

  it('needs a camera for views that show one', () => {
    assert.equal(isPresentingViewDisabled('me', 0), true);
    assert.equal(isPresentingViewDisabled('content-me', 0), true);
    assert.equal(isPresentingViewDisabled('content', 0), false);
    assert.equal(isPresentingViewDisabled('me', 1), false);
  });

  it('opens retired presenting layouts beside the content', () => {
    assert.deepEqual(MEDIA_SHARE_LAYOUT_ORDER, ['single', 'grid']);
    for (const retired of ['spotlight', 'pip', 'side-by-side', 'featured'] as const) {
      assert.equal(normalizeMediaShareLayout(retired), 'grid');
      assert.equal(getPresentingView(false, retired), 'content-me');
    }
    assert.equal(normalizeMediaShareLayout(undefined), 'grid');
    assert.equal(normalizeMediaShareLayout('single'), 'single');
  });
});
