import { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeBrandFont,
  normalizeCustomLayouts,
  type BrandFont,
  type BroadcastOrientation,
  type CustomLayout,
} from '@studio/shared';

/**
 * The studio's output format and layout library, kept per studio in this
 * browser: the output orientation, the saved custom layouts, which one the
 * stage uses, and the brand font. Brand kits carry the layouts and the font
 * to other studios and devices.
 */

export const STUDIO_FORMAT_STORAGE_PREFIX = 'livestream-studio:studio-format:';
const STUDIO_FORMAT_VERSION = 1;

export interface StudioFormatState {
  orientation: BroadcastOrientation;
  customLayouts: CustomLayout[];
  activeCustomLayoutId: string | null;
  brandFont: BrandFont | null;
}

export const DEFAULT_STUDIO_FORMAT: StudioFormatState = {
  orientation: 'landscape',
  customLayouts: [],
  activeCustomLayoutId: null,
  brandFont: null,
};

export function getStudioFormatStorageKey(roomId: string): string {
  return `${STUDIO_FORMAT_STORAGE_PREFIX}${roomId}`;
}

export function parseStudioFormat(json: string | null): StudioFormatState {
  if (!json) return DEFAULT_STUDIO_FORMAT;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || raw.version !== STUDIO_FORMAT_VERSION) return DEFAULT_STUDIO_FORMAT;
    const customLayouts = normalizeCustomLayouts(raw.customLayouts);
    const activeId = typeof raw.activeCustomLayoutId === 'string' ? raw.activeCustomLayoutId : null;
    return {
      orientation: raw.orientation === 'portrait' ? 'portrait' : 'landscape',
      customLayouts,
      activeCustomLayoutId: activeId && customLayouts.some((layout) => layout.id === activeId) ? activeId : null,
      brandFont: normalizeBrandFont(raw.brandFont),
    };
  } catch {
    return DEFAULT_STUDIO_FORMAT;
  }
}

export function serializeStudioFormat(state: StudioFormatState): string {
  return JSON.stringify({
    version: STUDIO_FORMAT_VERSION,
    orientation: state.orientation,
    customLayouts: normalizeCustomLayouts(state.customLayouts),
    activeCustomLayoutId: state.activeCustomLayoutId,
    brandFont: normalizeBrandFont(state.brandFont),
  });
}

/** Kit layouts first (same ids replace the studio's copy), then the studio's others; bounded. */
export function mergeCustomLayouts(current: CustomLayout[], incoming: CustomLayout[]): CustomLayout[] {
  const kit = normalizeCustomLayouts(incoming);
  if (kit.length === 0) return current;
  const kitIds = new Set(kit.map((layout) => layout.id));
  return normalizeCustomLayouts([...kit, ...current.filter((layout) => !kitIds.has(layout.id))]);
}

function readStored(roomId: string | undefined): StudioFormatState {
  if (!roomId) return DEFAULT_STUDIO_FORMAT;
  try {
    return parseStudioFormat(localStorage.getItem(getStudioFormatStorageKey(roomId)));
  } catch {
    return DEFAULT_STUDIO_FORMAT;
  }
}

export function useStudioFormat(roomId: string | undefined) {
  const [state, setState] = useState<StudioFormatState>(() => readStored(roomId));
  const loadedRoomRef = useRef(roomId);

  useEffect(() => {
    if (loadedRoomRef.current === roomId) return;
    loadedRoomRef.current = roomId;
    setState(readStored(roomId));
  }, [roomId]);

  useEffect(() => {
    if (!roomId || loadedRoomRef.current !== roomId) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(getStudioFormatStorageKey(roomId), serializeStudioFormat(state));
      } catch {
        // Private mode or full storage: the session keeps working.
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [roomId, state]);

  const setOrientation = useCallback((orientation: BroadcastOrientation) => {
    setState((current) => (current.orientation === orientation ? current : { ...current, orientation }));
  }, []);
  const setCustomLayouts = useCallback((next: CustomLayout[] | ((current: CustomLayout[]) => CustomLayout[])) => {
    setState((current) => {
      const layouts = normalizeCustomLayouts(typeof next === 'function' ? next(current.customLayouts) : next);
      const activeCustomLayoutId = current.activeCustomLayoutId && layouts.some((layout) => layout.id === current.activeCustomLayoutId)
        ? current.activeCustomLayoutId
        : null;
      return { ...current, customLayouts: layouts, activeCustomLayoutId };
    });
  }, []);
  const setActiveCustomLayoutId = useCallback((id: string | null) => {
    setState((current) => ({
      ...current,
      activeCustomLayoutId: id && current.customLayouts.some((layout) => layout.id === id) ? id : null,
    }));
  }, []);
  const setBrandFont = useCallback((brandFont: BrandFont | null) => {
    setState((current) => ({ ...current, brandFont: normalizeBrandFont(brandFont) }));
  }, []);
  /**
   * Applies a brand kit's layouts and font in one step. The kit's layouts are
   * added to (or replace same-id entries in) the studio's library, so applying
   * a kit never deletes layouts the studio already has.
   */
  const applyBrandKitFormat = useCallback((kit: { customLayouts?: CustomLayout[]; brandFont?: BrandFont | null }) => {
    setState((current) => {
      const layouts = mergeCustomLayouts(current.customLayouts, kit.customLayouts || []);
      return {
        ...current,
        customLayouts: layouts,
        activeCustomLayoutId: current.activeCustomLayoutId && layouts.some((layout) => layout.id === current.activeCustomLayoutId)
          ? current.activeCustomLayoutId
          : layouts[0]?.id ?? null,
        brandFont: kit.brandFont === undefined ? current.brandFont : normalizeBrandFont(kit.brandFont),
      };
    });
  }, []);

  return {
    ...state,
    setOrientation,
    setCustomLayouts,
    setActiveCustomLayoutId,
    setBrandFont,
    applyBrandKitFormat,
  };
}
