import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutMode } from '@studio/shared';
import { getPresentationGeometry, type PresentationRect, type PresentationCorner, type PresentationCameraSize, normalizePresentationCameraSize } from '../src/utils/presentationLayout.ts';
import { selectVisibleStageItems } from '../src/utils/mediaShareLayouts.ts';

const layouts: LayoutMode[] = ['single', 'grid', 'spotlight', 'side-by-side', 'pip', 'featured'];
const sizes: PresentationCameraSize[] = ['small', 'medium', 'large'];
const corners: PresentationCorner[] = ['TL', 'TR', 'BL', 'BR'];
const overlaps = (a: PresentationRect, b: PresentationRect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const assertInsideCanvas = (rect: PresentationRect) => {
  assert.ok(rect.width > 0 && rect.height > 0);
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.width <= 960 + 0.001);
  assert.ok(rect.y + rect.height <= 540 + 0.001);
};

describe('presentation composition', () => {
  it('keeps all camera tiles within the canvas, at 16:9, without overlapping each other', () => {
    for (const size of sizes) for (const layout of layouts) for (const corner of corners) for (let count = 0; count <= 12; count++) {
      const geometry = getPresentationGeometry(layout, count, corner, size);
      assertInsideCanvas(geometry.media);
      assert.equal(geometry.participants.length, geometry.visibleParticipantCount);
      geometry.participants.forEach((tile, index) => {
        assertInsideCanvas(tile);
        assert.ok(Math.abs(tile.width / tile.height - 16 / 9) < 0.001);
        geometry.participants.slice(index + 1).forEach(other => assert.equal(overlaps(tile, other), false));
        if (!geometry.usesFloatingParticipant) assert.equal(overlaps(tile, geometry.media), false);
      });
    }
  });

  it('gives content only the entire broadcast and renders no participant tiles', () => {
    const geometry = getPresentationGeometry('single', 12);
    assert.deepEqual(geometry.media, { x: 0, y: 0, width: 960, height: 540 });
    assert.deepEqual(selectVisibleStageItems(['host', 'guest'], 'single', {
      mediaVisibleParticipantCount: geometry.visibleParticipantCount,
    }), []);
  });

  it('keeps the full media frame in every empty-camera presentation', () => {
    for (const layout of layouts) {
      const { media, participants } = getPresentationGeometry(layout, 0);
      assert.deepEqual(media, { x: 0, y: 0, width: 960, height: 540 });
      assert.deepEqual(participants, []);
    }
  });

  it('moves the floating presenter to each corner without changing media framing', () => {
    const frames = corners.map(corner => getPresentationGeometry('pip', 1, corner));
    frames.forEach(frame => assert.deepEqual(frame.media, frames[0].media));
    const [tl, tr, bl, br] = frames.map(frame => frame.participants[0]);
    assert.equal(tl.x, bl.x);
    assert.equal(tr.x, br.x);
    assert.equal(tl.y, tr.y);
    assert.equal(bl.y, br.y);
    assert.ok(tr.x > tl.x && bl.y > tl.y);
  });

  it('gives hosts a useful presenter size range without changing floating media framing', () => {
    for (const layout of layouts.filter(layout => layout !== 'single')) {
      const frames = sizes.map(size => getPresentationGeometry(layout, 1, 'BR', size));
      assert.ok(frames[0].participants[0].width < frames[1].participants[0].width);
      assert.ok(frames[1].participants[0].width < frames[2].participants[0].width);
      if (frames[0].usesFloatingParticipant) frames.forEach(frame => assert.deepEqual(frame.media, frames[0].media));
    }
    assert.equal(normalizePresentationCameraSize('large'), 'large');
    for (const value of [null, undefined, 'invalid', 42]) assert.equal(normalizePresentationCameraSize(value), 'medium');
  });

  it('handles invalid counts without producing invalid geometry', () => {
    for (const count of [NaN, Infinity, -5]) {
      const result = getPresentationGeometry('pip', count);
      assertInsideCanvas(result.media);
      assert.deepEqual(result.participants, []);
    }
  });
});
