import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutMode } from '@studio/shared';
import {
  getMediaShareLayoutDescription,
  getMediaShareLayoutLabel,
  getStudioLayoutDescription,
  getStudioLayoutLabel,
  isMultiParticipantLayout,
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
    assert.equal(getMediaShareLayoutLabel('grid'), 'Media Rail');
    assert.equal(getMediaShareLayoutLabel('spotlight'), 'Speaker Strip');
    assert.equal(getMediaShareLayoutLabel('side-by-side'), 'Split Stage');
    assert.equal(getMediaShareLayoutLabel('featured'), 'Presenter Stack');
    assert.match(getMediaShareLayoutDescription('side-by-side'), /up to 2 participant videos/);
    assert.match(getMediaShareLayoutDescription('featured'), /stacked floating participant videos/);
    assert.match(getMediaShareLayoutDescription('pip'), /up to 4 floating participant videos/);
  });
});
