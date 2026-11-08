import type { CSSProperties } from 'react';
import type { StageContentPayload, StageControlAction } from '@studio/shared';
import { getStageRemoteView } from '../utils/stageControl.ts';

interface StageRemoteControlProps {
  /** What the host has on stage, as guests see it. */
  content: StageContentPayload | null;
  hostName: string;
  /** This co-host has media of their own staged, which guests do not see. */
  hasLocalMedia: boolean;
  onControl: (action: StageControlAction, slideIndex?: number) => void;
}

/**
 * A co-host's remote for the host's deck. The host's compositor makes the
 * broadcast, so the co-host advances the host's slides instead of staging a
 * copy that guests would see out of step with the stream.
 */
export function StageRemoteControl({ content, hostName, hasLocalMedia, onControl }: StageRemoteControlProps) {
  const view = getStageRemoteView(content);
  if (!view && !hasLocalMedia) return null;

  return (
    <div style={styles.bar} role="region" aria-label={`${hostName}'s stage controls`} data-testid="stage-remote-control">
      {view ? (
        <>
          <span style={styles.label}>
            <strong>{hostName}</strong> is presenting <span style={styles.name}>{view.name}</span>
            {view.slideIndex !== null && view.slideCount !== null && (
              <span style={styles.count}> · Slide {view.slideIndex + 1} of {view.slideCount}</span>
            )}
          </span>
          {view.slideCount !== null && (
            <>
              <button type="button" className="btn-ghost" style={styles.button} disabled={!view.canPrevious} onClick={() => onControl('previous')}>
                Previous
              </button>
              <select
                aria-label="Go to slide"
                style={styles.select}
                value={view.slideIndex ?? 0}
                onChange={(event) => onControl('goto', Number(event.target.value))}
              >
                {Array.from({ length: view.slideCount }, (_, index) => (
                  <option key={index} value={index}>Slide {index + 1}</option>
                ))}
              </select>
              <button type="button" className="btn-ghost" style={styles.button} disabled={!view.canNext} onClick={() => onControl('next')}>
                Next
              </button>
            </>
          )}
          <button type="button" className="btn-ghost" style={styles.button} onClick={() => onControl('clear')}>
            Take off stage
          </button>
        </>
      ) : null}
      {hasLocalMedia && (
        <span style={styles.note}>
          Guests and the broadcast follow {hostName}&apos;s stage, not yours.
        </span>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 10,
    background: 'var(--bg-secondary, rgba(15, 23, 42, 0.8))',
    border: '1px solid var(--border, rgba(255, 255, 255, 0.1))',
    fontSize: 13,
    color: 'var(--text-primary)',
  },
  label: {
    marginRight: 4,
  },
  name: {
    fontStyle: 'italic',
  },
  count: {
    color: 'var(--text-secondary)',
  },
  button: {
    fontSize: 13,
    padding: '4px 10px',
  },
  select: {
    fontSize: 13,
    padding: '3px 6px',
    borderRadius: 6,
    border: '1px solid var(--control-border, rgba(255, 255, 255, 0.15))',
    background: 'var(--control-bg, transparent)',
    color: 'var(--text-primary)',
  },
  note: {
    fontSize: 12,
    color: 'var(--warning, #f59e0b)',
  },
};
