import type { CSSProperties } from 'react';
import type { LayoutMode } from '@studio/shared';

export const LAYOUT_SWITCH_TRANSITION_DURATION_MS = 300;
/** Me / Content / Content + Me: a full fade, long enough to read as deliberate. */
export const VIEW_SWITCH_TRANSITION_DURATION_MS = 420;

export interface StageLayoutTransition {
  id: number;
  from: LayoutMode;
  to: LayoutMode;
  visible: boolean;
  /** A presenting-view switch fades the whole stage in from nothing. */
  kind?: 'layout' | 'view';
}

export function shouldStartLayoutTransition(from: LayoutMode, to: LayoutMode): boolean {
  return from !== to;
}

export function getStageLayoutTransitionStyle(
  transition: Pick<StageLayoutTransition, 'visible' | 'kind'> | null
): CSSProperties {
  if (!transition) return {};

  if (transition.kind === 'view') {
    // The tiles jump to their new places while invisible, then fade and settle in.
    return {
      opacity: transition.visible ? 1 : 0,
      transform: transition.visible ? 'scale(1)' : 'scale(0.97)',
      transformOrigin: 'center center',
      transition: transition.visible
        ? `opacity ${VIEW_SWITCH_TRANSITION_DURATION_MS}ms ease, transform ${VIEW_SWITCH_TRANSITION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
        : 'none',
      willChange: 'opacity, transform',
    };
  }

  return {
    opacity: transition.visible ? 1 : 0.84,
    transform: transition.visible ? 'scale(1)' : 'scale(0.985)',
    transformOrigin: 'center center',
    transition: `opacity ${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms ease, transform ${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1), gap ${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms ease`,
    willChange: 'opacity, transform',
  };
}
