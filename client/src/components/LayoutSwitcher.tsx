import '../styles/presentation.css';
import type { LayoutMode } from '@studio/shared';
import {
  getStudioLayoutDescription,
  getStudioLayoutLabel,
  isPresentingViewDisabled,
  isStudioLayoutDisabled,
  PRESENTING_VIEW_DESCRIPTIONS,
  getPresentingViewLabel,
  PRESENTING_VIEWS,
  STUDIO_LAYOUT_PRESET_ORDER,
  type PresentingView,
} from '../utils/layoutPresets.ts';
import {
  getMediaShareLayoutVisibilitySummary,
} from '../utils/mediaShareLayouts.ts';

interface LayoutSwitcherProps {
  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  participantCount: number;
  isMediaActive?: boolean;
  mediaParticipantCount?: number;
  /** While presenting: which view is on stage, and how to change it. */
  presentingView?: PresentingView;
  onPresentingViewChange?: (view: PresentingView) => void;
  /** The custom layout the Custom button shows; null opens the editor instead. */
  customLayoutName?: string | null;
  onOpenCustomLayouts?: () => void;
}

const layoutIcons: Record<LayoutMode, React.ReactNode> = {
  custom: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="2" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3.5" y="4.5" width="6" height="5" rx="1" fill="currentColor" opacity="0.55" />
      <circle cx="12.5" cy="11.5" r="2.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  grid: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
  ),
  spotlight: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="16" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="6.75" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="12.5" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
  ),
  'side-by-side': (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="9.5" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
  ),
  featured: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.5" y="2" width="3.5" height="14" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
  ),
  pip: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="10" width="6" height="5" rx="1" fill="currentColor" opacity="0.5" stroke="currentColor" strokeWidth="1" />
      </svg>
  ),
  single: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
  ),
};


/** Miniature of the broadcast: the light block is the content, accent blocks are presenters. */
function PresentingViewGlyph({ view }: { view: PresentingView }) {
  const content = (x: number, y: number, w: number, h: number) => <rect x={x} y={y} width={w} height={h} rx="1.5" fill="currentColor" opacity="0.55" />;
  const presenter = (x: number, y: number, w: number, h: number) => <rect x={x} y={y} width={w} height={h} rx="1" className="presentation-glyph-presenter" />;
  const shapes: Record<PresentingView, React.ReactNode> = {
    me: presenter(2, 2, 28, 16),
    content: content(2, 2, 28, 16),
    'content-me': <>{content(2, 3, 19, 14)}{presenter(23, 7.5, 7, 5)}</>,
  };
  return <svg width="32" height="20" viewBox="0 0 32 20" aria-hidden="true" className="presentation-glyph">
    <rect x="0.5" y="0.5" width="31" height="19" rx="3" fill="none" stroke="currentColor" opacity="0.35" />
    {shapes[view]}
  </svg>;
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatPersonCount(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function formatMediaVisibilityLabel(
  layout: LayoutMode,
  mediaParticipantCount: number
): string {
  const summary = getMediaShareLayoutVisibilitySummary(layout, mediaParticipantCount);
  if (summary.totalParticipantCount === 0) return 'Media only';
  if (summary.hiddenParticipantCount > 0) {
    return `${summary.visibleParticipantCount}/${summary.totalParticipantCount} people visible`;
  }
  return `${formatPersonCount(summary.visibleParticipantCount)} visible`;
}

export function LayoutSwitcher({
  currentLayout,
  onLayoutChange,
  participantCount,
  isMediaActive = false,
  mediaParticipantCount,
  presentingView = 'content-me',
  onPresentingViewChange,
  customLayoutName = null,
  onOpenCustomLayouts,
}: LayoutSwitcherProps) {
  const activeMediaParticipantCount = normalizeCount(mediaParticipantCount ?? Math.max(0, participantCount - 1));

  if (isMediaActive) {
    const summary = getMediaShareLayoutVisibilitySummary(currentLayout, activeMediaParticipantCount);
    const showHiddenCount = presentingView === 'content-me' && summary.hiddenParticipantCount > 0;
    return <div className="presentation-layouts">
      <div className="presentation-layout-options" role="group" aria-label="Presentation view">
        {PRESENTING_VIEWS.map((view, index) => <button type="button" key={view} aria-pressed={presentingView === view}
          aria-label={`${getPresentingViewLabel(view, activeMediaParticipantCount)} view`}
          aria-keyshortcuts={String(index + 1)}
          title={`${PRESENTING_VIEW_DESCRIPTIONS[view]} (${index + 1})`}
          disabled={isPresentingViewDisabled(view, activeMediaParticipantCount)}
          onClick={() => onPresentingViewChange?.(view)}>
          <PresentingViewGlyph view={view} />
          <span>{getPresentingViewLabel(view, activeMediaParticipantCount)}</span>
        </button>)}
      </div>
      {showHiddenCount && <div className="presentation-layout-tuning">
        <span className="presentation-layout-hint">{formatMediaVisibilityLabel(currentLayout, activeMediaParticipantCount)}</span>
      </div>}
    </div>;
  }

  return (
    <div style={styles.wrap}>
      <style>{`
        .ls-btn:hover:not(:disabled):not([aria-disabled="true"]) {
          color: white !important;
          background: rgba(255, 255, 255, 0.1) !important;
          transform: scale(1.1);
        }
        .ls-btn:active:not(:disabled):not([aria-disabled="true"]) {
          transform: scale(0.95);
        }
        .ls-btn[aria-disabled="true"] { cursor: not-allowed; }
        .ls-hint { font-size: 12px; color: var(--text-secondary); text-align: center; line-height: 1.4; }
        .ls-btn.active {
          background: var(--accent) !important;
          color: white !important;
          box-shadow: 0 1px 6px rgba(124, 58, 237, 0.4), 0 0 0 1px rgba(167, 139, 250, 0.2) !important;
        }
        .ls-btn.active:hover {
          transform: none;
        }
      `}</style>
      <div style={styles.controlRow}>
        <div style={styles.bar} role="radiogroup" aria-label="Layout switcher">
          {STUDIO_LAYOUT_PRESET_ORDER.map((mode, index) => {
            const label = getStudioLayoutLabel(mode);
            const description = getStudioLayoutDescription(mode);
            const isActive = currentLayout === mode;
            const isDisabled = isStudioLayoutDisabled(mode, participantCount);
            return (
              <button
                key={mode}
                className={`ls-btn ${isActive ? 'active' : ''}`}
                role="radio"
                aria-checked={isActive}
                aria-label={isDisabled ? `${label} layout - unlocks when a guest joins the stage` : `${label} layout - ${description}`}
                aria-describedby={isDisabled ? 'layout-switcher-hint' : undefined}
                // Still focusable (aria-disabled), so keyboard and screen-reader users learn why.
                onClick={() => { if (!isDisabled) onLayoutChange(mode); }}
                aria-disabled={isDisabled || undefined}
                aria-keyshortcuts={String(index + 1)}
                title={isDisabled ? `${label}: unlocks when a guest joins the stage` : `${label} - ${description} (${index + 1})`}
                style={{
                  ...styles.btn,
                  ...(isDisabled ? styles.btnDisabled : {}),
                }}
              >
                {layoutIcons[mode]}
              </button>
            );
          })}
          {onOpenCustomLayouts && (
            <button
              type="button"
              className={`ls-btn ${currentLayout === 'custom' ? 'active' : ''}`}
              role="radio"
              aria-checked={currentLayout === 'custom'}
              aria-label={customLayoutName ? `Custom layout - ${customLayoutName}` : 'Custom layout - open the layout editor'}
              title={customLayoutName ? `Custom: ${customLayoutName}` : 'Custom layout: design your own'}
              style={styles.btn}
              onClick={() => (customLayoutName ? onLayoutChange('custom') : onOpenCustomLayouts())}
            >
              {layoutIcons.custom}
            </button>
          )}
        </div>
        {onOpenCustomLayouts && (
          <button
            type="button"
            className="ls-btn"
            aria-label="Edit custom layouts"
            title="Edit custom layouts"
            style={styles.btn}
            onClick={onOpenCustomLayouts}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        )}
      </div>
      {STUDIO_LAYOUT_PRESET_ORDER.some((mode) => isStudioLayoutDisabled(mode, participantCount)) && (
        <p id="layout-switcher-hint" className="ls-hint">Multi-person layouts unlock when a guest joins the stage.</p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    maxWidth: 'min(100%, 420px)',
  },
  controlRow: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  bar: {
    display: 'inline-flex',
    gap: 2,
    background: 'rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: 10,
    padding: 3,
    border: '1px solid rgba(255, 255, 255, 0.08)',
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 26,
    borderRadius: 7,
    background: 'transparent',
    color: 'rgba(255, 255, 255, 0.5)',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    transition: 'all 0.12s ease',
  },
  btnDisabled: {
    opacity: 0.25,
    cursor: 'not-allowed',
  },
};
