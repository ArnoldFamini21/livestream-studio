import type { LayoutMode } from '@studio/shared';

export type MediaShareParticipantPlacement = 'side-rail' | 'bottom-strip' | 'side-by-side' | 'pip';

export interface MediaShareLayoutPlan {
  placement: MediaShareParticipantPlacement;
  visibleParticipantCount: number;
  mediaIsDominant: boolean;
  usesFloatingParticipant: boolean;
}

const MAX_SIDE_RAIL_PARTICIPANTS = 4;
const MAX_BOTTOM_STRIP_PARTICIPANTS = 6;

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
        visibleParticipantCount: 1,
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
