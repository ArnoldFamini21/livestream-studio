import { useEffect, useState } from 'react';
import type { BrandFont } from '@studio/shared';
import { loadBrandFontFaces } from '../utils/brandFontStore.ts';

export interface BrandFontState {
  /** The loaded font stack, or null while loading / when using the default face. */
  fontFamily: string | null;
  status: 'default' | 'loading' | 'ready' | 'missing' | 'error';
  message: string | null;
}

const DEFAULT_STATE: BrandFontState = { fontFamily: null, status: 'default', message: null };

/**
 * Loads the brand font before anything draws with it. Until it is ready the
 * previous face keeps drawing, so the program never flashes a fallback face.
 */
export function useBrandFont(font: BrandFont | null): BrandFontState {
  const [state, setState] = useState<BrandFontState>(DEFAULT_STATE);
  const key = font ? JSON.stringify(font) : '';

  useEffect(() => {
    if (!font) {
      setState(DEFAULT_STATE);
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, status: 'loading', message: null }));
    void loadBrandFontFaces(font).then((result) => {
      if (cancelled) return;
      setState(result.status === 'ready'
        ? { fontFamily: result.family, status: 'ready', message: null }
        : { fontFamily: null, status: result.status, message: result.message });
    });
    return () => {
      cancelled = true;
    };
    // The key captures the font's content; the object identity may change on every render.
  }, [key]);

  return state;
}
