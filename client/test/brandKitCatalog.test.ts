import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrandKitCatalogEntry } from '@studio/shared';
import type { SavedBrandKit } from '../src/utils/brandKits.ts';
import {
  buildBrandKitCatalogUpsertRequest,
  catalogEntryToSavedBrandKit,
} from '../src/utils/brandKitCatalog.ts';

const savedBrandKit: SavedBrandKit = {
  id: 'kit-1',
  name: 'Launch Brand',
  createdAt: '2026-07-02T10:00:00.000Z',
  studioTheme: 'colorful',
  brandColor: '#2563eb',
  stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a, #2563eb)' },
  logoUrl: 'data:image/png;base64,logo',
  logoPlacement: 'bottom-right',
  logoPosition: { x: 0.37, y: 0.18 },
  logoSize: 'large',
  logoOpacity: 0.45,
  cameraShape: 'rounded',
  nameTagStyle: 'block',
};

describe('brand kit catalog client helpers', () => {
  it('builds bounded server upsert payloads from saved brand kits', () => {
    assert.deepEqual(buildBrandKitCatalogUpsertRequest(savedBrandKit), {
      id: 'kit-1',
      name: 'Launch Brand',
      createdAt: '2026-07-02T10:00:00.000Z',
      studioTheme: 'colorful',
      brandColor: '#2563eb',
      stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a, #2563eb)' },
      logoUrl: 'data:image/png;base64,logo',
      logoPlacement: 'bottom-right',
      logoPosition: { x: 0.37, y: 0.18 },
      logoSize: 'large',
      logoOpacity: 0.45,
      cameraShape: 'rounded',
      nameTagStyle: 'block',
    });
  });

  it('converts server catalog entries back to local dashboard brand kits', () => {
    const entry: BrandKitCatalogEntry = {
      ...savedBrandKit,
      roomId: 'room-1',
      updatedAt: '2026-07-02T10:05:00.000Z',
    };

    assert.deepEqual(catalogEntryToSavedBrandKit(entry), savedBrandKit);
  });
});
