/**
 * Co-host slide control. Only the stage owner (the host, see getStageOwnerId)
 * mirrors the stage to guests, because its compositor makes the broadcast. A
 * co-host drives the owner's deck with 'stage-control' messages instead of
 * staging a copy of their own, so guests, the broadcast and the recording all
 * show the same slide.
 */
import type { ActiveMedia, StageContentPayload, StageControlAction, StageControlPayload } from '@studio/shared';
import {
  clampPresentationSlideIndex,
  getNextPresentationSlideIndex,
  getPresentationSlides,
} from './presentationDeckControls.ts';

/** The id guests know the staged media by (same as buildStageContent). */
export function getStageMediaId(media: Pick<ActiveMedia, 'assetId' | 'url' | 'name'> | null | undefined): string | null {
  if (!media) return null;
  return media.assetId || media.url || media.name || null;
}

export interface StageDeckState {
  media: ActiveMedia | null;
  slideIndex: number;
}

export type StageControlOutcome =
  | { kind: 'slide'; slideIndex: number }
  | { kind: 'clear' }
  | { kind: 'ignore'; reason: 'stale' | 'nothing-staged' | 'no-deck' | 'unchanged' };

/**
 * What the stage owner does with a command. A command aimed at media that is
 * no longer on stage (the co-host clicked just as the host switched decks) is
 * ignored rather than applied to the wrong deck.
 */
export function resolveStageControl(command: Pick<StageControlPayload, 'action' | 'slideIndex' | 'mediaId'>, deck: StageDeckState): StageControlOutcome {
  if (!deck.media) return { kind: 'ignore', reason: 'nothing-staged' };
  const mediaId = getStageMediaId(deck.media);
  if (command.mediaId && command.mediaId !== mediaId) return { kind: 'ignore', reason: 'stale' };
  if (command.action === 'clear') return { kind: 'clear' };
  const total = getPresentationSlides(deck.media).length;
  if (total <= 1) return { kind: 'ignore', reason: 'no-deck' };
  const current = clampPresentationSlideIndex(deck.slideIndex, total);
  let next = current;
  if (command.action === 'next') next = getNextPresentationSlideIndex(current, total, 'next');
  else if (command.action === 'previous') next = getNextPresentationSlideIndex(current, total, 'previous');
  else if (command.action === 'goto') next = clampPresentationSlideIndex(command.slideIndex ?? current, total);
  if (next === current) return { kind: 'ignore', reason: 'unchanged' };
  return { kind: 'slide', slideIndex: next };
}

/** The command a co-host's remote sends for what guests currently see. */
export function buildStageControl(
  action: StageControlAction,
  content: StageContentPayload | null | undefined,
  slideIndex?: number,
): StageControlPayload {
  return {
    action,
    ...(action === 'goto' && typeof slideIndex === 'number' ? { slideIndex: Math.max(0, Math.floor(slideIndex)) } : {}),
    ...(content?.media?.id ? { mediaId: content.media.id } : {}),
  };
}

export interface StageRemoteView {
  name: string;
  /** Zero-based slide on stage, when the media is a deck. */
  slideIndex: number | null;
  slideCount: number | null;
  canPrevious: boolean;
  canNext: boolean;
}

/** What the co-host's remote shows for the stage owner's content, or null when nothing is staged. */
export function getStageRemoteView(content: StageContentPayload | null | undefined): StageRemoteView | null {
  const media = content?.media;
  if (!media) return null;
  const count = typeof media.slideCount === 'number' && media.slideCount > 1 ? media.slideCount : null;
  const index = count !== null ? clampPresentationSlideIndex(media.slideIndex ?? 0, count) : null;
  return {
    name: media.name,
    slideIndex: index,
    slideCount: count,
    canPrevious: index !== null && index > 0,
    canNext: index !== null && count !== null && index < count - 1,
  };
}
