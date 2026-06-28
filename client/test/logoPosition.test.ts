import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCustomLogoPositionStyle,
  getLogoCanvasRect,
  getLogoPositionFromPlacement,
  getLogoPositionFromPointer,
  normalizeLogoPosition,
} from '../src/utils/logoPosition.ts';

describe('logo position utilities', () => {
  it('normalizes logo coordinates defensively', () => {
    assert.deepEqual(normalizeLogoPosition({ x: 0.25, y: 0.75 }), { x: 0.25, y: 0.75 });
    assert.deepEqual(normalizeLogoPosition({ x: -1, y: 2 }), { x: 0, y: 1 });
    assert.equal(normalizeLogoPosition({ x: 'bad', y: 0.5 }), null);
    assert.equal(normalizeLogoPosition(null), null);
  });

  it('builds CSS styles for custom logo positions', () => {
    assert.deepEqual(getCustomLogoPositionStyle({ x: 0.5, y: 0.125 }), {
      left: '50%',
      top: '12.5%',
      transform: 'translate(-50%, -50%)',
    });
  });

  it('maps pointer coordinates into normalized stage positions', () => {
    assert.deepEqual(
      getLogoPositionFromPointer(260, 150, { left: 100, top: 50, width: 400, height: 200 }),
      { x: 0.4, y: 0.5 }
    );
    assert.deepEqual(
      getLogoPositionFromPointer(50, 400, { left: 100, top: 50, width: 400, height: 200 }),
      { x: 0, y: 1 }
    );
    assert.equal(getLogoPositionFromPointer(50, 400, { left: 100, top: 50, width: 0, height: 200 }), null);
  });

  it('provides corner-based custom starting coordinates', () => {
    assert.deepEqual(getLogoPositionFromPlacement('top-left'), { x: 0.08, y: 0.08 });
    assert.deepEqual(getLogoPositionFromPlacement('bottom-right'), { x: 0.92, y: 0.86 });
  });

  it('computes canvas rects for corners and custom positions', () => {
    assert.deepEqual(
      getLogoCanvasRect({
        sourceWidth: 200,
        sourceHeight: 100,
        placement: 'bottom-right',
        size: 'medium',
      }),
      { x: 1824, y: 1026, width: 84, height: 42 }
    );

    assert.deepEqual(
      getLogoCanvasRect({
        sourceWidth: 200,
        sourceHeight: 100,
        position: { x: 0.5, y: 0.5 },
        size: 'medium',
      }),
      { x: 918, y: 519, width: 84, height: 42 }
    );

    assert.equal(getLogoCanvasRect({ sourceWidth: 0, sourceHeight: 100 }), null);
  });
});
