export type CompositorFrameTargetMode = 'offscreen' | 'canvas';

export interface CompositorFrameTarget {
  mode: CompositorFrameTargetMode;
  context: CanvasRenderingContext2D;
  commit: () => void;
  dispose: () => void;
}

interface CompositorFrameTargetOptions {
  width: number;
  height: number;
  globalScope?: Record<string, unknown>;
}

interface OffscreenCanvasLike {
  getContext: (contextId: '2d') => unknown;
  transferToImageBitmap?: () => ImageBitmap;
}

interface ImageBitmapLike {
  close?: () => void;
}

function getGlobalScope(globalScope?: Record<string, unknown>): Record<string, unknown> {
  return globalScope || globalThis as unknown as Record<string, unknown>;
}

export function supportsOffscreenCompositor(globalScope?: Record<string, unknown>): boolean {
  const root = getGlobalScope(globalScope);
  if (typeof root.OffscreenCanvas !== 'function') return false;
  try {
    const canvas = new (root.OffscreenCanvas as new (width: number, height: number) => OffscreenCanvasLike)(16, 16);
    if (typeof canvas.getContext !== 'function' || typeof canvas.transferToImageBitmap !== 'function') {
      return false;
    }
    const context = canvas.getContext('2d') as { roundRect?: unknown } | null;
    return Boolean(context) && typeof context?.roundRect === 'function';
  } catch {
    return false;
  }
}

export function createCompositorFrameTarget(
  canvas: HTMLCanvasElement,
  options: CompositorFrameTargetOptions
): CompositorFrameTarget | null {
  const visibleContext = canvas.getContext('2d');
  if (!visibleContext) return null;

  const root = getGlobalScope(options.globalScope);
  if (supportsOffscreenCompositor(root)) {
    try {
      const offscreen = new (root.OffscreenCanvas as new (width: number, height: number) => OffscreenCanvasLike)(
        options.width,
        options.height
      );
      const offscreenContext = offscreen.getContext('2d') as CanvasRenderingContext2D | null;
      if (offscreenContext && typeof offscreen.transferToImageBitmap === 'function') {
        return {
          mode: 'offscreen',
          context: offscreenContext,
          commit: () => {
            const bitmap = offscreen.transferToImageBitmap?.();
            if (!bitmap) return;
            visibleContext.drawImage(bitmap, 0, 0);
            (bitmap as ImageBitmapLike).close?.();
          },
          dispose: () => undefined,
        };
      }
    } catch {
      // Fall back to direct canvas rendering below.
    }
  }

  return {
    mode: 'canvas',
    context: visibleContext,
    commit: () => undefined,
    dispose: () => undefined,
  };
}
