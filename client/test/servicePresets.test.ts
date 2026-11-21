import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CUSTOM_LAYOUTS, type CustomLayout, type Scene } from '@studio/shared';
import { buildScenePack, importScenePack, MAX_SCENE_PACK_BYTES, parseScenePackJson } from '../src/utils/scenePacks.ts';
import { captureServicePreset, createServicePresetDownload, groupServicePresets, parseServicePresetFile, prepareServicePreset } from '../src/utils/servicePresets.ts';

const original: CustomLayout = {
  id: 'original', name: 'Service', orientation: 'landscape',
  slots: [{ id: 'camera', x: 0, y: 0, w: 0.8, h: 1, kind: 'camera', shape: 'rect', z: 0, participantId: 'old-room-guest' }],
};
const artwork = 'data:image/png;base64,' + 'a'.repeat(160_000);
const scene: Scene = {
  id: 'scene-1', name: 'Sabbath service', layout: 'custom', customLayoutId: 'original',
  logoUrl: artwork, brandColor: '#202020', background: { type: 'image', value: artwork }, visibleOverlayIds: [],
};
const makePack = () => buildScenePack({ scenes: [scene], lowerThirds: [], banners: [], timers: [], tickers: [], widgets: [] });

test('a preset retains complete artwork and remaps a colliding custom layout', () => {
  const pack = parseScenePackJson(JSON.stringify(makePack()));
  assert.equal(pack.scenes[0].logoUrl, artwork);
  assert.equal(pack.scenes[0].background.value, artwork);
  const preset = captureServicePreset(pack, [original, { ...original, id: 'unused' }]);
  assert.deepEqual(preset.layouts.map(layout => layout.id), ['original']);
  assert.equal(preset.layouts[0].slots[0].participantId, undefined);
  const existing = { ...original, name: 'Another layout' };
  const copy = prepareServicePreset(preset, [existing], 3, () => 'imported');
  assert.equal(copy.layouts[0], existing);
  assert.equal(copy.layouts[1].id, 'imported');
  assert.equal(copy.pack.scenes[0].customLayoutId, 'imported');
  assert.equal(importScenePack(copy.pack, { existingScenes: [] }).scenes[0].customLayoutId, 'imported');
});

test('a preset reuses matching layouts and refuses to silently drop a required layout', () => {
  const preset = captureServicePreset(makePack(), [original]);
  const cloned = { ...preset.layouts[0], id: 'reused' };
  const copy = prepareServicePreset(preset, [cloned], 1, () => assert.fail('matching layout should be reused'));
  assert.equal(copy.pack.scenes[0].customLayoutId, 'reused');
  const full = Array.from({ length: MAX_CUSTOM_LAYOUTS }, (_, index) => ({ ...original, id: 'other-' + index, name: 'Other' + index }));
  assert.throws(() => prepareServicePreset(preset, full, 1), /Make room for a custom layout/);
  assert.throws(() => prepareServicePreset(preset, [], 0), /Make room for a scene/);
  assert.throws(() => captureServicePreset(makePack(), []), /missing custom layout/);
});


test('a downloadable service preset retains its artwork and layout without local identifiers', () => {
  const snapshot = captureServicePreset(makePack(), [original]);
  const file = createServicePresetDownload({ ...snapshot, id: 'local-private-id', folderId: 'local-folder-private-id', name: 'Sabbath service', createdAt: '2026-11-21' });
  assert.equal(file.fileName, 'sabbath-service.service-preset.json');
  assert.doesNotMatch(file.contents, /local-private-id|local-folder-private-id|old-room-guest|folderId/);
  const restored = parseServicePresetFile(file.contents);
  assert.equal(restored.name, 'Sabbath service');
  assert.equal(restored.snapshot.pack.scenes[0].logoUrl, artwork);
  assert.equal(restored.snapshot.layouts[0].slots[0].participantId, undefined);
  assert.equal(prepareServicePreset(restored.snapshot, [], 1, () => 'restored-layout').pack.scenes[0].customLayoutId, 'restored-layout');
});

test('foreign, oversized, and incomplete service preset files are rejected', () => {
  const snapshot = captureServicePreset(makePack(), [original]);
  const { contents } = createServicePresetDownload({ ...snapshot, id: 'local', name: 'Service', createdAt: '' });
  const file = JSON.parse(contents);
  assert.throws(() => parseServicePresetFile(JSON.stringify({ ...file, version: 2 })), /downloaded from Studio/);
  assert.throws(() => parseServicePresetFile(JSON.stringify({ ...file, layouts: [] })), /missing custom layout/);
  assert.throws(() => parseServicePresetFile(' '.repeat(MAX_SCENE_PACK_BYTES + 513)), /too large/);
  assert.throws(() => parseServicePresetFile('{bad'), /not valid JSON/);
});


test('folders group presets by stable IDs and leave legacy and orphaned presets visible', () => {
  const snapshot = captureServicePreset(makePack(), [original]);
  const legacy = { ...snapshot, id: 'legacy', name: 'Legacy', createdAt: '2026-11-21' };
  const filed = { ...legacy, id: 'filed', folderId: 'weekly' };
  const orphaned = { ...legacy, id: 'orphaned', folderId: 'missing' };
  const folder = { id: 'weekly', name: 'Weekly services' };
  const emptyFolder = { id: 'special', name: 'Special events' };

  const result = groupServicePresets({ presets: [legacy, filed, orphaned], folders: [folder, emptyFolder] });
  assert.deepEqual(result.groups, [{ ...folder, presets: [filed] }, { ...emptyFolder, presets: [] }]);
  assert.deepEqual(result.unfiled, [legacy, orphaned]);
});
