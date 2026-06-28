import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBackgroundPreview,
  getProductionSceneTemplateConfig,
  PRODUCTION_SCENE_TEMPLATE_CARDS,
} from '../src/utils/productionSceneTemplates.ts';

test('production scene template cards are unique and have matching configs', () => {
  const ids = new Set(PRODUCTION_SCENE_TEMPLATE_CARDS.map((template) => template.id));

  assert.equal(ids.size, PRODUCTION_SCENE_TEMPLATE_CARDS.length);

  for (const template of PRODUCTION_SCENE_TEMPLATE_CARDS) {
    const config = getProductionSceneTemplateConfig(template.id);

    assert.equal(config.layout, template.layout);
    assert.equal(config.background.value, template.background.value);
    assert.equal(config.brandColor, template.accent);
    assert.ok(config.banner?.visible);
    assert.ok(config.ticker?.visible);
  }
});

test('starting soon template includes a visible five minute countdown', () => {
  const config = getProductionSceneTemplateConfig('starting-soon');

  assert.equal(config.timer?.visible, true);
  assert.equal(config.timer?.mode, 'countdown');
  assert.equal(config.timer?.durationSeconds, 300);
  assert.equal(config.timer?.remainingSeconds, 300);
});

test('new producer templates cover audience questions and screen share workflows', () => {
  const qa = getProductionSceneTemplateConfig('live-q-and-a');
  const screenShare = getProductionSceneTemplateConfig('screen-share');

  assert.equal(qa.layout, 'featured');
  assert.equal(qa.banner?.text, 'Live Q&A');
  assert.match(qa.ticker?.text ?? '', /questions/i);

  assert.equal(screenShare.layout, 'pip');
  assert.equal(screenShare.banner?.text, 'Screen Share');
  assert.match(screenShare.ticker?.text ?? '', /shared screen/i);
});

test('background previews return renderable css values', () => {
  assert.equal(getBackgroundPreview({ type: 'none', value: '' }), '#09090b');
  assert.equal(getBackgroundPreview({ type: 'color', value: '#111827' }), '#111827');
  assert.equal(
    getBackgroundPreview({ type: 'image', value: 'https://example.test/stage.png' }),
    'url(https://example.test/stage.png) center/cover no-repeat',
  );
  assert.equal(
    getBackgroundPreview({ type: 'video', value: 'https://example.test/stage.mp4' }),
    'linear-gradient(135deg, #111827 0%, #334155 100%)',
  );
});
