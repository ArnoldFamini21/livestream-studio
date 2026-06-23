import type { CSSProperties } from 'react';
import { CHAT_REACTION_EMOJIS, type ChatReactionType } from '@studio/shared';

export interface FloatingReaction {
  id: string;
  reaction: ChatReactionType;
  createdAt: number;
  lane: number;
  size: number;
  delayMs: number;
}

export const REACTION_OVERLAY_DURATION_MS = 2600;
export const REACTION_OVERLAY_LANES = [18, 31, 45, 58, 72, 84] as const;

export function createFloatingReaction(
  reaction: ChatReactionType,
  sequence: number,
  now = Date.now()
): FloatingReaction {
  const lane = REACTION_OVERLAY_LANES[sequence % REACTION_OVERLAY_LANES.length];
  return {
    id: `reaction-${now}-${sequence}`,
    reaction,
    createdAt: now,
    lane,
    size: 34 + (sequence % 4) * 4,
    delayMs: (sequence % 3) * 70,
  };
}

interface ReactionOverlayProps {
  reactions: FloatingReaction[];
}

export function ReactionOverlay({ reactions }: ReactionOverlayProps) {
  if (reactions.length === 0) return null;

  return (
    <div aria-hidden="true" style={styles.container}>
      <style>{reactionOverlayKeyframes}</style>
      {reactions.map((item) => (
        <span
          key={item.id}
          style={{
            ...styles.reaction,
            left: `${item.lane}%`,
            fontSize: item.size,
            animationDelay: `${item.delayMs}ms`,
          }}
        >
          {CHAT_REACTION_EMOJIS[item.reaction]}
        </span>
      ))}
    </div>
  );
}

const reactionOverlayKeyframes = `
@keyframes reactionFloatUp {
  0% { opacity: 0; transform: translate3d(-50%, 26px, 0) scale(0.74); }
  14% { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1); }
  70% { opacity: 0.94; transform: translate3d(calc(-50% + 18px), -230px, 0) scale(1.12); }
  100% { opacity: 0; transform: translate3d(calc(-50% - 10px), -360px, 0) scale(0.94); }
}

@media (prefers-reduced-motion: reduce) {
  @keyframes reactionFloatUp {
    0% { opacity: 0; transform: translate3d(-50%, 0, 0) scale(0.96); }
    18% { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1); }
    100% { opacity: 0; transform: translate3d(-50%, -40px, 0) scale(1); }
  }
}
`;

const styles: Record<string, CSSProperties> = {
  container: {
    position: 'absolute',
    inset: 0,
    zIndex: 37,
    pointerEvents: 'none',
    overflow: 'hidden',
  },
  reaction: {
    position: 'absolute',
    bottom: 74,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 58,
    height: 58,
    lineHeight: 1,
    filter: 'drop-shadow(0 10px 20px rgba(0, 0, 0, 0.42))',
    textShadow: '0 2px 10px rgba(0, 0, 0, 0.38)',
    transform: 'translateX(-50%)',
    animation: `reactionFloatUp ${REACTION_OVERLAY_DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
    willChange: 'opacity, transform',
  },
};
