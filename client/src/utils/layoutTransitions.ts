import type { CSSProperties } from 'react';
import type { LayoutMode } from '@studio/shared';

export const LAYOUT_SWITCH_TRANSITION_DURATION_MS = 300;

export interface StageLayoutTransition {
  id: number;
  from: LayoutMode;
  to: LayoutMode;
  visible: boolean;
}

export function shouldStartLayoutTransition(from: LayoutMode, to: LayoutMode): boolean {
  return from !== to;
}

export function getStageLayoutTransitionStyle(
  transition: Pick<StageLayoutTransition, 'visible'> | null
): CSSProperties {
  if (!transition) return {};

  return {
    opacity: transition.visible ? 1 : 0.84,
    transform: transition.visible ? 'scale(1)' : 'scale(0.985)',
    transformOrigin: 'center center',
    transition: `opacity ${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms ease, transform ${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1), gap ${LAYOUT_SWITCH_TRANSITION_DURATION_MS}ms ease`,
    willChange: 'opacity, transform',
  };
}
