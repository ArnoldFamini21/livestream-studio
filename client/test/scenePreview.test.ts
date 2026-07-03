import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutMode } from '@studio/shared';
import {
  getScenePreviewLogoPosition,
  getScenePreviewOverlays,
  getScenePreviewPipTilePosition,
  getScenePreviewTiles,
} from '../src/utils/scenePreview.ts';

describe('scene preview thumbnails', () => {
  it('returns deterministic tile geometry for every studio layout', () => {
    const expectedTileCounts: Record<LayoutMode, number> = {
      grid: 4,
      spotlight: 4,
      'side-by-side': 2,
      pip: 2,
      single: 1,
      featured: 3,
    };

    for (const [layout, count] of Object.entries(expectedTileCounts) as Array<[LayoutMode, number]>) {
      const tiles = getScenePreviewTiles(layout);

      assert.equal(tiles.length, count);
      assert.ok(tiles.every((tile) => tile.left.endsWith('%')));
      assert.ok(tiles.every((tile) => tile.top.endsWith('%')));
      assert.ok(tiles.every((tile) => tile.width.endsWith('%')));
      assert.ok(tiles.every((tile) => tile.height.endsWith('%')));
    }
  });

  it('marks primary and floating tiles for asymmetric layouts', () => {
    assert.equal(getScenePreviewTiles('spotlight')[0].primary, true);
    assert.equal(getScenePreviewTiles('featured')[0].primary, true);
    assert.equal(getScenePreviewTiles('pip')[1].floating, true);
  });

  it('uses shared-media geometry when a saved scene contains active media', () => {
    const tiles = getScenePreviewTiles('grid', { mediaActive: true });

    assert.equal(tiles.length, 4);
    assert.equal(tiles[0].media, true);
    assert.equal(tiles[0].primary, true);
    assert.equal(tiles[0].width, '65%');
    assert.ok(tiles.slice(1).every((tile) => tile.left === '77%'));
  });

  it('shows shared media as the dominant tile for strip and split scene previews', () => {
    const spotlightTiles = getScenePreviewTiles('spotlight', { mediaActive: true });
    const splitTiles = getScenePreviewTiles('side-by-side', { mediaActive: true });

    assert.equal(spotlightTiles[0].media, true);
    assert.equal(spotlightTiles[0].height, '55%');
    assert.ok(spotlightTiles.slice(1).every((tile) => tile.top === '70%'));

    assert.equal(splitTiles[0].media, true);
    assert.equal(splitTiles[0].width, '57%');
    assert.ok(splitTiles.slice(1).every((tile) => tile.left === '70%'));
  });

  it('preserves saved PiP corners in shared-media scene previews', () => {
    const tiles = getScenePreviewTiles('pip', {
      mediaActive: true,
      mediaParticipantCount: 2,
      pipCorner: 'TL',
    });

    assert.equal(tiles.length, 3);
    assert.equal(tiles[0].media, true);
    assert.deepEqual(
      tiles.slice(1).map(({ left, top, floating }) => ({ left, top, floating })),
      [
        { left: '10%', top: '14%', floating: true },
        { left: '10%', top: '33%', floating: true },
      ]
    );
  });

  it('renders a media-only scene preview without inventing participant tiles', () => {
    const tiles = getScenePreviewTiles('featured', {
      mediaActive: true,
      mediaParticipantCount: 0,
    });

    assert.deepEqual(tiles, [
      { left: '7%', top: '8%', width: '86%', height: '72%', primary: true, media: true },
    ]);
  });

  it('positions PiP preview tiles from saved scene corners', () => {
    assert.deepEqual(getScenePreviewPipTilePosition('TL'), { left: '10%', top: '14%' });
    assert.deepEqual(getScenePreviewPipTilePosition('TR'), { left: '63%', top: '14%' });
    assert.deepEqual(getScenePreviewPipTilePosition('BL'), { left: '10%', top: '54%' });
    assert.deepEqual(getScenePreviewPipTilePosition('BR'), { left: '63%', top: '54%' });
    assert.deepEqual(getScenePreviewPipTilePosition(undefined), { left: '63%', top: '54%' });

    const topLeftPipTile = getScenePreviewTiles('pip', { pipCorner: 'TL' })[1];
    assert.equal(topLeftPipTile.left, '10%');
    assert.equal(topLeftPipTile.top, '14%');
  });

  it('detects saved scene overlay cues from existing scene ids', () => {
    assert.deepEqual(
      getScenePreviewOverlays({
        logoUrl: 'https://example.test/logo.png',
        visibleOverlayIds: ['lt-host', 'banner-2', 'ticker-3', 'timer-4', 'widget-5', 'unknown-6'],
        activeMedia: null,
      }),
      {
        lowerThird: true,
        banner: true,
        ticker: true,
        timer: true,
        widget: true,
        logo: true,
        media: false,
      }
    );
  });

  it('marks saved scene media in preview metadata', () => {
    const overlays = getScenePreviewOverlays({
      logoUrl: null,
      visibleOverlayIds: [],
      activeMedia: { assetId: 'media-1', slideIndex: 2 },
    });

    assert.equal(overlays.media, true);
  });

  it('positions logo markers by saved placement', () => {
    assert.deepEqual(getScenePreviewLogoPosition('top-left'), { top: '8%', left: '8%' });
    assert.deepEqual(getScenePreviewLogoPosition('bottom-right'), { bottom: '14%', right: '8%' });
    assert.deepEqual(getScenePreviewLogoPosition(undefined), { top: '8%', right: '8%' });
    assert.deepEqual(getScenePreviewLogoPosition('top-right', { x: 0.25, y: 0.5 }), {
      left: '25%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
    });
  });
});
