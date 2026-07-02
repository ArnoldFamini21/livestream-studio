import type { LayoutMode } from '@studio/shared';

export type MediaShareParticipantPlacement = 'side-rail' | 'bottom-strip' | 'side-by-side' | 'pip';

export interface MediaShareLayoutPlan {
  placement: MediaShareParticipantPlacement;
  visibleParticipantCount: number;
  mediaIsDominant: boolean;
  usesFloatingParticipant: boolean;
}

export interface SharedMediaParticipantItem {
  id: string;
}

export interface VisibleStageItemSelectionOptions {
  mediaVisibleParticipantCount?: number | null;
  hasScreenShare?: boolean;
}

const MAX_SIDE_RAIL_PARTICIPANTS = 4;
const MAX_BOTTOM_STRIP_PARTICIPANTS = 6;
const MAX_SPLIT_PARTICIPANTS = 2;
const MAX_FLOATING_PIP_PARTICIPANTS = 2;

function normalizeParticipantCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

export function getMediaShareLayoutPlan(layout: LayoutMode, participantCount: number): MediaShareLayoutPlan {
  const count = normalizeParticipantCount(participantCount);

  if (count === 0) {
    return {
      placement: 'side-rail',
      visibleParticipantCount: 0,
      mediaIsDominant: true,
      usesFloatingParticipant: false,
    };
  }

  switch (layout) {
    case 'pip':
      return {
        placement: 'pip',
        visibleParticipantCount: Math.min(count, MAX_FLOATING_PIP_PARTICIPANTS),
        mediaIsDominant: true,
        usesFloatingParticipant: true,
      };
    case 'single':
      return {
        placement: 'pip',
        visibleParticipantCount: 1,
        mediaIsDominant: true,
        usesFloatingParticipant: true,
      };
    case 'side-by-side':
      return {
        placement: 'side-by-side',
        visibleParticipantCount: Math.min(count, MAX_SPLIT_PARTICIPANTS),
        mediaIsDominant: false,
        usesFloatingParticipant: false,
      };
    case 'spotlight':
      return {
        placement: 'bottom-strip',
        visibleParticipantCount: Math.min(count, MAX_BOTTOM_STRIP_PARTICIPANTS),
        mediaIsDominant: true,
        usesFloatingParticipant: false,
      };
    case 'grid':
    case 'featured':
      return {
        placement: 'side-rail',
        visibleParticipantCount: Math.min(count, MAX_SIDE_RAIL_PARTICIPANTS),
        mediaIsDominant: true,
        usesFloatingParticipant: false,
      };
  }
}

export function mergeSharedMediaParticipantItems<T extends SharedMediaParticipantItem>(
  stageItems: T[],
  presenterFallbackItems: T[],
  maxFallbackItems = presenterFallbackItems.length
): T[] {
  const safeLimit = Math.max(0, Math.floor(Number.isFinite(maxFallbackItems) ? maxFallbackItems : 0));
  if (safeLimit === 0 || presenterFallbackItems.length === 0) return stageItems;

  const stageIds = new Set(stageItems.map((item) => item.id));
  const mergedFallbacks: T[] = [];
  const fallbackIds = new Set<string>();

  for (const item of presenterFallbackItems) {
    if (mergedFallbacks.length >= safeLimit) break;
    if (stageIds.has(item.id) || fallbackIds.has(item.id)) continue;
    mergedFallbacks.push(item);
    fallbackIds.add(item.id);
  }

  if (mergedFallbacks.length === 0) return stageItems;
  return [...mergedFallbacks, ...stageItems];
}

export function selectVisibleStageItems<T>(
  stageItems: T[],
  layout: LayoutMode,
  options: VisibleStageItemSelectionOptions = {}
): T[] {
  if (typeof options.mediaVisibleParticipantCount === 'number') {
    return stageItems.slice(0, normalizeParticipantCount(options.mediaVisibleParticipantCount));
  }

  if (options.hasScreenShare) return stageItems;

  switch (layout) {
    case 'side-by-side':
      return stageItems.slice(0, 2);
    case 'single':
      return stageItems.slice(0, 1);
    case 'pip':
      return stageItems.slice(0, 2);
    case 'grid':
    case 'spotlight':
    case 'featured':
      return stageItems;
  }
}
