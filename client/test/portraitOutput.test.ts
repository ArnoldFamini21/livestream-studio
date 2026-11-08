import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getContextCanvasSize,
  getProgramCanvasSize,
  isPortraitCanvas,
} from '../src/utils/compositorCanvasSize.ts';
import { getCompositorCoordinateScales } from '../src/utils/compositorCoordinates.ts';
import {
  getPortraitGridColumnCount,
  getPortraitPresentationGeometry,
  getPortraitPresentationLayout,
  getPortraitStageLayout,
  getPortraitStageRects,
  type PortraitRect,
} from '../src/utils/portraitLayouts.ts';
import { fitStageCanvas, getStageCanvasSize } from '../src/utils/stageCanvas.ts';
import { getProgramReturnSize } from '../src/utils/programReturn.ts';
import { getRtmpRelayVideoConfig } from '../src/utils/rtmpRelayOutput.ts';

const W = 540;
const H = 960;

function inside(rect: PortraitRect) {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= W + 1e-6 && rect.y + rect.height <= H + 1e-6;
}

function overlaps(a: PortraitRect, b: PortraitRect) {
  return a.x < b.x + b.width - 1e-6 && b.x < a.x + a.width - 1e-6 && a.y < b.y + b.height - 1e-6 && b.y < a.y + a.height - 1e-6;
}

describe('portrait program size', () => {
  it('sizes the program canvas by orientation', () => {
    assert.deepEqual(getProgramCanvasSize('landscape'), { width: 1920, height: 1080 });
    assert.deepEqual(getProgramCanvasSize('portrait'), { width: 1080, height: 1920 });
    assert.equal(isPortraitCanvas(getProgramCanvasSize('portrait')), true);
  });

  it('reads the size of the canvas a context draws into', () => {
    assert.deepEqual(getContextCanvasSize({ canvas: { width: 1080, height: 1920 } }), { width: 1080, height: 1920 });
    assert.deepEqual(getContextCanvasSize({}), { width: 1920, height: 1080 });
    assert.deepEqual(getContextCanvasSize({ canvas: { width: 0, height: 0 } }), { width: 1920, height: 1080 });
  });

  it('lays the stage out at 9:16 so DOM rects map onto 1080x1920 at the same scale', () => {
    assert.deepEqual(getStageCanvasSize('portrait'), { width: 540, height: 960 });
    assert.deepEqual(fitStageCanvas(540, 960, 'portrait'), { width: 540, height: 960, scale: 1 });
    // A wide window fits the portrait stage by height.
    const fitted = fitStageCanvas(1600, 480, 'portrait');
    assert.equal(fitted.height, 480);
    assert.equal(fitted.width, 270);
    const scales = getCompositorCoordinateScales({ width: 270, height: 480 }, { width: 540, height: 960 }, getProgramCanvasSize('portrait'))!;
    assert.equal(scales.displayScaleX, scales.displayScaleY);
    assert.equal(scales.logicalScaleX, 2);
    assert.equal(scales.logicalScaleY, 2);
  });

  it('sends true portrait to the relay and keeps the return feed portrait', () => {
    assert.deepEqual(getRtmpRelayVideoConfig('portrait', 'standard-1080p'), { width: 1080, height: 1920, frameRate: 30, videoBitsPerSecond: 4_500_000 });
    assert.deepEqual(getRtmpRelayVideoConfig('portrait', 'smooth-720p'), { width: 720, height: 1280, frameRate: 30, videoBitsPerSecond: 2_500_000 });
    assert.deepEqual(getProgramReturnSize(1080, 1920), { width: 360, height: 640 });
    assert.deepEqual(getProgramReturnSize(1920, 1080), { width: 640, height: 360 });
  });
});

describe('stacked portrait layouts', () => {
  it('stacks up to three people in one column, then two, then three across', () => {
    assert.equal(getPortraitGridColumnCount(1), 1);
    assert.equal(getPortraitGridColumnCount(3), 1);
    assert.equal(getPortraitGridColumnCount(4), 2);
    assert.equal(getPortraitGridColumnCount(8), 2);
    assert.equal(getPortraitGridColumnCount(9), 3);
    const three = getPortraitStageRects('grid', 3);
    assert.equal(new Set(three.map((rect) => rect.x)).size, 1, 'one column');
    assert.ok(three[0].y < three[1].y && three[1].y < three[2].y, 'top to bottom');
  });

  it('keeps every tile on the canvas without overlap, for every layout', () => {
    for (const layout of ['grid', 'spotlight', 'featured', 'side-by-side', 'single'] as const) {
      for (let count = 1; count <= 10; count += 1) {
        const rects = getPortraitStageRects(layout, count);
        assert.ok(rects.length >= 1);
        rects.forEach((rect) => assert.ok(inside(rect), `${layout} ${count}`));
        for (let a = 0; a < rects.length; a += 1) {
          for (let b = a + 1; b < rects.length; b += 1) assert.ok(!overlaps(rects[a], rects[b]), `${layout} ${count} ${a}/${b}`);
        }
      }
    }
    assert.equal(getPortraitStageRects('side-by-side', 5).length, 2);
    assert.equal(getPortraitStageRects('single', 4).length, 1);
  });

  it('gives the spotlight a large top tile and floats the PiP tile in its corner', () => {
    const [main, ...rest] = getPortraitStageRects('spotlight', 4);
    assert.ok(main.height > rest[0].height * 2);
    assert.ok(rest.every((rect) => rect.y > main.y + main.height));
    const pip = getPortraitStageRects('pip', 2, 'TL');
    assert.deepEqual(pip[0], { x: 0, y: 0, width: W, height: H });
    assert.ok(pip[1].x < W / 2 && pip[1].y < H / 2);
    const styles = getPortraitStageLayout('pip', 2, 'BR').tileStyles;
    assert.equal(styles[1].position, 'absolute');
    assert.ok(Number(styles[1].zIndex) > Number(styles[0].zIndex));
  });

  it('puts shared content above the cameras when presenting in portrait', () => {
    const geometry = getPortraitPresentationGeometry('grid', 2, 16 / 9);
    assert.equal(geometry.participants.length, 2);
    assert.ok(inside(geometry.media));
    assert.ok(geometry.participants.every((rect) => rect.y >= geometry.media.y + geometry.media.height && inside(rect)));
    assert.ok(Math.abs(geometry.media.width / geometry.media.height - 16 / 9) < 0.01, 'content keeps its shape');
    const contentOnly = getPortraitPresentationLayout('single', 3, 16 / 9);
    assert.equal(contentOnly.visibleParticipantCount, 0);
    assert.equal(contentOnly.participantStyles.length, 0);
    assert.equal(contentOnly.mediaStyle.position, 'absolute');
  });
});
