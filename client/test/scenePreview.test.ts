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
        visibleOverlayIds: ['lt-host', 'banner-2', 'ticker-3', 'timer-4', 'unknown-5'],
      }),
      {
        lowerThird: true,
        banner: true,
        ticker: true,
        timer: true,
        logo: true,
      }
    );
  });

  it('positions logo markers by saved placement', () => {
    assert.deepEqual(getScenePreviewLogoPosition('top-left'), { top: '8%', left: '8%' });
    assert.deepEqual(getScenePreviewLogoPosition('bottom-right'), { bottom: '14%', right: '8%' });
    assert.deepEqual(getScenePreviewLogoPosition(undefined), { top: '8%', right: '8%' });
  });
});
