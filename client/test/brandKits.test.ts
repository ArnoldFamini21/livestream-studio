import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_SAVED_BRAND_KITS,
  buildBrandKitName,
  createSavedBrandKit,
  getPersistableBrandLogoUrl,
  getPersistableBrandStageBackground,
  parseSavedBrandKits,
  serializeSavedBrandKits,
  type SavedBrandKit,
} from '../src/utils/brandKits.ts';

const visuals = {
  studioTheme: 'colorful' as const,
  brandColor: '#2563eb',
  stageBackground: { type: 'gradient' as const, value: 'linear-gradient(135deg, #0f172a, #1d4ed8)' },
  logoUrl: 'data:image/png;base64,logo',
  logoPlacement: 'bottom-right' as const,
  logoPosition: { x: 0.37, y: 0.18 },
  logoSize: 'large' as const,
  logoOpacity: 0.45,
  cameraShape: 'rounded' as const,
  nameTagStyle: 'block' as const,
};

describe('brand kits', () => {
  it('creates a portable saved brand kit from current visuals', () => {
    const kit = createSavedBrandKit('Show Brand', visuals, [], 'kit-1', '2026-06-24T00:00:00.000Z');

    assert.deepEqual(kit, {
      id: 'kit-1',
      name: 'Show Brand',
      createdAt: '2026-06-24T00:00:00.000Z',
      ...visuals,
      customLayouts: [],
      brandFont: null,
    });
  });

  it('carries custom layouts and the brand font through save and reload', () => {
    const layout = {
      id: 'layout-1',
      name: 'Slides + 2',
      orientation: 'portrait' as const,
      slots: [
        { id: 'content', x: 0.04, y: 0.03, w: 0.92, h: 0.46, z: 0, shape: 'rounded' as const, kind: 'content' as const },
        { id: 'cam', x: 0.04, y: 0.52, w: 0.45, h: 0.45, z: 1, shape: 'circle' as const, kind: 'camera' as const, participantId: 'guest-1' },
      ],
    };
    const font = { source: 'upload' as const, family: 'Channel Sans', fileId: 'font-abc', fileName: 'channel.woff2' };
    const kit = createSavedBrandKit('Vertical', { ...visuals, customLayouts: [layout], brandFont: font }, [], 'kit-v', '2026-06-24T00:00:00.000Z');
    assert.deepEqual(kit.customLayouts, [layout]);
    assert.deepEqual(kit.brandFont, font);

    const [reloaded] = parseSavedBrandKits(serializeSavedBrandKits([kit]));
    assert.deepEqual(reloaded.customLayouts, [layout]);
    assert.deepEqual(reloaded.brandFont, font);

    // Kits saved before layouts existed load with none and the default face.
    const legacy = parseSavedBrandKits(JSON.stringify([{ ...kit, customLayouts: undefined, brandFont: { source: 'preset', presetId: 'nope' } }]))[0];
    assert.deepEqual(legacy.customLayouts, []);
    assert.equal(legacy.brandFont, null);
  });

  it('deduplicates names while keeping them within the sidebar limit', () => {
    assert.equal(buildBrandKitName('Show Brand', ['Show Brand']), 'Show Brand 2');
    assert.equal(
      buildBrandKitName('A very long brand kit name for a live show', [], 16),
      'A very long bran'
    );
  });

  it('strips non-persistable blob background and logo URLs', () => {
    assert.deepEqual(
      getPersistableBrandStageBackground({ type: 'image', value: 'blob:https://example.test/logo' }),
      { type: 'none', value: '' }
    );
    assert.deepEqual(
      getPersistableBrandStageBackground({ type: 'video', value: 'blob:https://example.test/loop' }),
      { type: 'none', value: '' }
    );
    assert.deepEqual(
      getPersistableBrandStageBackground({ type: 'video', value: 'https://cdn.example.test/loop.mp4' }),
      { type: 'video', value: 'https://cdn.example.test/loop.mp4' }
    );
    assert.equal(getPersistableBrandLogoUrl('blob:https://example.test/logo'), null);

    const kit = createSavedBrandKit('Blob Kit', {
      ...visuals,
      stageBackground: { type: 'image', value: 'blob:https://example.test/bg' },
      logoUrl: 'blob:https://example.test/logo',
    }, [], 'kit-blob', '2026-06-24T00:00:00.000Z');

    assert.deepEqual(kit.stageBackground, { type: 'none', value: '' });
    assert.equal(kit.logoUrl, null);
  });

  it('parses saved kits defensively and caps the stored list', () => {
    const kit: SavedBrandKit = createSavedBrandKit('Show Brand', visuals, [], 'kit-1', '2026-06-24T00:00:00.000Z');
    const many = Array.from({ length: MAX_SAVED_BRAND_KITS + 3 }, (_, index) => ({
      ...kit,
      id: `kit-${index}`,
      name: `Kit ${index}`,
    }));

    assert.deepEqual(parseSavedBrandKits(null), []);
    assert.deepEqual(parseSavedBrandKits('not json'), []);
    assert.equal(parseSavedBrandKits(JSON.stringify([{ bad: true }, kit])).length, 1);
    assert.equal(parseSavedBrandKits(JSON.stringify(many)).length, MAX_SAVED_BRAND_KITS);
    assert.equal(parseSavedBrandKits(JSON.stringify([{ ...kit, studioTheme: 'bad' }]))[0]?.studioTheme, 'dark');
    assert.equal(parseSavedBrandKits(JSON.stringify([{ ...kit, logoOpacity: 0.05 }]))[0]?.logoOpacity, 0.2);
    assert.deepEqual(parseSavedBrandKits(JSON.stringify([{ ...kit, logoPosition: { x: 2, y: -1 } }]))[0]?.logoPosition, { x: 1, y: 0 });
  });

  it('serializes only valid saved brand kits', () => {
    const kit = createSavedBrandKit('Show Brand', visuals, [], 'kit-1', '2026-06-24T00:00:00.000Z');
    const serialized = serializeSavedBrandKits([kit, { ...kit, id: '', name: '' }]);

    assert.deepEqual(JSON.parse(serialized), [kit]);
  });
});
