import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCENE_TRANSITION_PRESET_ID,
  getSceneTransitionOverlayStyle,
  getSceneTransitionPresetLabel,
  isPersistableSceneStingerClip,
  normalizeSceneTransitionPresetId,
  normalizeSceneStingerClip,
  validateSceneStingerFile,
} from '../src/utils/sceneTransitions.ts';

describe('scene transition presets', () => {
  it('normalizes unknown transition ids to the default crossfade preset', () => {
    assert.equal(normalizeSceneTransitionPresetId('wipe'), 'wipe');
    assert.equal(normalizeSceneTransitionPresetId('stinger'), 'stinger');
    assert.equal(normalizeSceneTransitionPresetId('missing'), DEFAULT_SCENE_TRANSITION_PRESET_ID);
    assert.equal(normalizeSceneTransitionPresetId(null), DEFAULT_SCENE_TRANSITION_PRESET_ID);
  });

  it('returns readable labels for transition controls', () => {
    assert.equal(getSceneTransitionPresetLabel('fade'), 'Crossfade');
    assert.equal(getSceneTransitionPresetLabel('slide'), 'Slide');
    assert.equal(getSceneTransitionPresetLabel('stinger'), 'Stinger');
  });

  it('builds distinct overlay styles for wipe, slide, zoom, and stinger transitions', () => {
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

    const stinger = getSceneTransitionOverlayStyle({
      presetId: 'stinger',
      visible: true,
      durationMs: 520,
    });
    assert.equal(stinger.opacity, 1);
    assert.match(String(stinger.background), /0\.72/);
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

  it('validates stinger video files by type, extension, and size', () => {
    assert.equal(validateSceneStingerFile({ name: 'intro.webm', type: '', size: 1024 }), null);
    assert.equal(validateSceneStingerFile({ name: 'intro.mov', type: 'application/octet-stream', size: 1024 }), null);
    assert.equal(validateSceneStingerFile({ name: 'intro.bin', type: 'video/mp4', size: 1024 }), null);
    assert.match(validateSceneStingerFile({ name: 'intro.png', type: 'image/png', size: 1024 }) || '', /video/i);
    assert.match(validateSceneStingerFile({ name: 'intro.mp4', type: 'video/mp4', size: 41 * 1024 * 1024 }) || '', /40 MB/);
  });

  it('normalizes stinger clips and only persists URL-backed clips', () => {
    const upload = normalizeSceneStingerClip({
      name: ' Uploaded intro ',
      url: 'blob:https://example.com/clip',
      source: 'upload',
      mimeType: 'video/webm',
    });
    assert.deepEqual(upload, {
      name: 'Uploaded intro',
      url: 'blob:https://example.com/clip',
      source: 'upload',
      mimeType: 'video/webm',
    });
    assert.equal(isPersistableSceneStingerClip(upload), false);

    const urlClip = normalizeSceneStingerClip({
      name: 'Remote intro',
      url: 'https://cdn.example.com/intro.mp4',
      source: 'url',
    });
    assert.equal(urlClip?.url, 'https://cdn.example.com/intro.mp4');
    assert.equal(isPersistableSceneStingerClip(urlClip), true);

    assert.equal(normalizeSceneStingerClip({ name: '', url: 'https://example.com/a.mp4', source: 'url' }), null);
    assert.equal(isPersistableSceneStingerClip(normalizeSceneStingerClip({ name: 'Bad', url: 'javascript:alert(1)', source: 'url' })), false);
  });
});
