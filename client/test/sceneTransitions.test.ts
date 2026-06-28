import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCENE_TRANSITION_PRESET_ID,
  getSceneTransitionOverlayStyle,
  getSceneTransitionPresetLabel,
  normalizeSceneTransitionPresetId,
} from '../src/utils/sceneTransitions.ts';

describe('scene transition presets', () => {
  it('normalizes unknown transition ids to the default crossfade preset', () => {
    assert.equal(normalizeSceneTransitionPresetId('wipe'), 'wipe');
    assert.equal(normalizeSceneTransitionPresetId('missing'), DEFAULT_SCENE_TRANSITION_PRESET_ID);
    assert.equal(normalizeSceneTransitionPresetId(null), DEFAULT_SCENE_TRANSITION_PRESET_ID);
  });

  it('returns readable labels for transition controls', () => {
    assert.equal(getSceneTransitionPresetLabel('fade'), 'Crossfade');
    assert.equal(getSceneTransitionPresetLabel('slide'), 'Slide');
  });

  it('builds distinct overlay styles for wipe, slide, and zoom transitions', () => {
    const wipe = getSceneTransitionOverlayStyle({
      presetId: 'wipe',
      visible: false,
      durationMs: 520,
      brandColor: '#14b8a6',
    });
    assert.equal(wipe.clipPath, 'inset(0 0 0 100%)');
    assert.match(String(wipe.background), /#14b8a6/);

    const slide = getSceneTransitionOverlayStyle({
      presetId: 'slide',
      visible: false,
      durationMs: 520,
    });
    assert.equal(slide.transform, 'translateX(105%)');

    const zoom = getSceneTransitionOverlayStyle({
      presetId: 'zoom',
      visible: false,
      durationMs: 520,
    });
    assert.equal(zoom.opacity, 0);
    assert.equal(zoom.transform, 'scale(1.08)');
  });

  it('bounds transition duration to prevent invisible or excessive animations', () => {
    const tooFast = getSceneTransitionOverlayStyle({
      presetId: 'fade',
      visible: true,
      durationMs: 10,
    });
    assert.match(String(tooFast.transition), /120ms/);

    const tooSlow = getSceneTransitionOverlayStyle({
      presetId: 'fade',
      visible: true,
      durationMs: 3000,
    });
    assert.match(String(tooSlow.transition), /1500ms/);
  });
});
