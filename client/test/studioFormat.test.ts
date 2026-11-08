import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_STUDIO_FORMAT,
  getStudioFormatStorageKey,
  mergeCustomLayouts,
  parseStudioFormat,
  serializeStudioFormat,
} from '../src/hooks/useStudioFormat.ts';
import { createCustomLayoutFromTemplate } from '../src/utils/customLayouts.ts';

const pip = createCustomLayoutFromTemplate('picture-in-picture', 'portrait', [], 'layout-pip');
const three = createCustomLayoutFromTemplate('three-up', 'landscape', [], 'layout-three');

describe('studio output format storage', () => {
  it('round-trips orientation, layouts, the active layout and the brand font', () => {
    const state = {
      orientation: 'portrait' as const,
      customLayouts: [pip, three],
      activeCustomLayoutId: 'layout-pip',
      brandFont: { source: 'preset' as const, presetId: 'oswald' as const },
    };
    assert.deepEqual(parseStudioFormat(serializeStudioFormat(state)), state);
    assert.equal(getStudioFormatStorageKey('room-1'), 'livestream-studio:studio-format:room-1');
  });

  it('falls back to the defaults for missing, broken or foreign data', () => {
    assert.deepEqual(parseStudioFormat(null), DEFAULT_STUDIO_FORMAT);
    assert.deepEqual(parseStudioFormat('{nope'), DEFAULT_STUDIO_FORMAT);
    assert.deepEqual(parseStudioFormat(JSON.stringify({ version: 99, orientation: 'portrait' })), DEFAULT_STUDIO_FORMAT);
  });

  it('drops an active layout id that no saved layout has, and invalid fonts', () => {
    const parsed = parseStudioFormat(JSON.stringify({
      version: 1,
      orientation: 'sideways',
      customLayouts: [three, { id: 'bad', name: '', slots: [] }],
      activeCustomLayoutId: 'layout-gone',
      brandFont: { source: 'preset', presetId: 'papyrus' },
    }));
    assert.equal(parsed.orientation, 'landscape');
    assert.deepEqual(parsed.customLayouts.map((layout) => layout.id), ['layout-three']);
    assert.equal(parsed.activeCustomLayoutId, null);
    assert.equal(parsed.brandFont, null);
  });
});

describe('applying brand kit layouts', () => {
  it('puts the kit layouts first, replaces same ids and keeps the studio others', () => {
    const renamed = { ...three, name: 'Kit three-up' };
    const merged = mergeCustomLayouts([three, pip], [renamed]);
    assert.deepEqual(merged.map((layout) => layout.id), ['layout-three', 'layout-pip']);
    assert.equal(merged[0].name, 'Kit three-up');
  });

  it('keeps the studio layouts when the kit has none', () => {
    const current = [pip];
    assert.equal(mergeCustomLayouts(current, []), current);
  });
});
