import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCompositorFrameTarget,
  supportsOffscreenCompositor,
} from '../src/utils/compositorFrameTarget.ts';

function createVisibleCanvas() {
  const drawCalls: unknown[][] = [];
  const visibleContext = {
    drawImage: (...args: unknown[]) => drawCalls.push(args),
  };
  return {
    drawCalls,
    canvas: {
      getContext: (contextId: string) => (contextId === '2d' ? visibleContext : null),
    } as unknown as HTMLCanvasElement,
  };
}

describe('compositor frame target', () => {
  it('uses OffscreenCanvas when a transferable 2D target is available', () => {
    const offscreenContext = { fillRect: () => undefined, roundRect: () => undefined };
    const bitmap = { closed: false, close() { this.closed = true; } };
    const root = {
      OffscreenCanvas: class {
        width: number;
        height: number;

        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }

        getContext(contextId: string) {
          return contextId === '2d' ? offscreenContext : null;
        }

        transferToImageBitmap() {
          return bitmap;
        }
      },
    };
    const { canvas, drawCalls } = createVisibleCanvas();

    assert.equal(supportsOffscreenCompositor(root), true);
    const target = createCompositorFrameTarget(canvas, { width: 1920, height: 1080, globalScope: root });

    assert.equal(target?.mode, 'offscreen');
    assert.equal(target?.context, offscreenContext);

    target?.commit();

    assert.equal(drawCalls.length, 1);
    assert.equal(drawCalls[0][0], bitmap);
    assert.equal(bitmap.closed, true);
  });

  it('falls back to direct canvas rendering when OffscreenCanvas is unavailable', () => {
    const { canvas, drawCalls } = createVisibleCanvas();

    assert.equal(supportsOffscreenCompositor({}), false);
    const target = createCompositorFrameTarget(canvas, { width: 1920, height: 1080, globalScope: {} });

    assert.equal(target?.mode, 'canvas');
    target?.commit();
    assert.equal(drawCalls.length, 0);
  });

  it('falls back when the OffscreenCanvas context lacks required drawing primitives', () => {
    const root = {
      OffscreenCanvas: class {
        getContext() {
          return { fillRect: () => undefined };
        }

        transferToImageBitmap() {
          return { close: () => undefined };
        }
      },
    };
    const { canvas } = createVisibleCanvas();

    assert.equal(supportsOffscreenCompositor(root), false);
    const target = createCompositorFrameTarget(canvas, { width: 1920, height: 1080, globalScope: root });

    assert.equal(target?.mode, 'canvas');
  });

  it('falls back when the visible capture canvas has no 2D context', () => {
    const target = createCompositorFrameTarget({
      getContext: () => null,
    } as unknown as HTMLCanvasElement, {
      width: 1920,
      height: 1080,
      globalScope: {},
    });

    assert.equal(target, null);
  });
});
