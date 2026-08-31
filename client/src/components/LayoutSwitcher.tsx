import type { LayoutMode } from '@studio/shared';
import {
  getMediaShareLayoutDescription,
  getMediaShareLayoutLabel,
  getStudioLayoutDescription,
  getStudioLayoutLabel,
  isMultiParticipantLayout,
  STUDIO_LAYOUT_PRESET_ORDER,
} from '../utils/layoutPresets.ts';
import {
  getMediaShareLayoutVisibilitySummary,
  getRecommendedMediaShareLayout,
} from '../utils/mediaShareLayouts.ts';

interface LayoutSwitcherProps {
  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  participantCount: number;
  isMediaActive?: boolean;
  mediaParticipantCount?: number;
}

const layoutIcons: Record<LayoutMode, React.ReactNode> = {
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

function formatMediaVisibilityTitle(
  layout: LayoutMode,
  mediaParticipantCount: number
): string {
  const summary = getMediaShareLayoutVisibilitySummary(layout, mediaParticipantCount);
  if (summary.totalParticipantCount === 0) return 'No participant cameras are visible with the shared media.';
  if (summary.hiddenParticipantCount > 0) {
    return `Shows ${formatPersonCount(summary.visibleParticipantCount)} and hides ${formatPersonCount(summary.hiddenParticipantCount)}.`;
  }
  return `Shows all ${formatPersonCount(summary.totalParticipantCount)}.`;
}

export function LayoutSwitcher({
  currentLayout,
  onLayoutChange,
  participantCount,
  isMediaActive = false,
  mediaParticipantCount,
}: LayoutSwitcherProps) {
  const activeMediaParticipantCount = normalizeCount(mediaParticipantCount ?? Math.max(0, participantCount - 1));
  const recommendedMediaLayout = isMediaActive ? getRecommendedMediaShareLayout(activeMediaParticipantCount) : null;
  const selectedMediaSummary = isMediaActive
    ? getMediaShareLayoutVisibilitySummary(currentLayout, activeMediaParticipantCount)
    : null;
  const selectedMediaVisibilityLabel = isMediaActive
    ? formatMediaVisibilityLabel(currentLayout, activeMediaParticipantCount)
    : '';
  const recommendationLabel = recommendedMediaLayout ? getMediaShareLayoutLabel(recommendedMediaLayout) : '';
  const canApplyRecommendation = Boolean(
    isMediaActive &&
    recommendedMediaLayout &&
    currentLayout !== recommendedMediaLayout &&
    (activeMediaParticipantCount > 0 || recommendedMediaLayout === 'grid')
  );

  return (
    <div style={styles.wrap}>
      <style>{`
        .ls-btn:hover:not(:disabled) {
          color: white !important;
          background: rgba(255, 255, 255, 0.1) !important;
          transform: scale(1.1);
        }
        .ls-btn:active:not(:disabled) {
          transform: scale(0.95);
        }
        .ls-btn.active {
          background: var(--accent) !important;
          color: white !important;
          box-shadow: 0 1px 6px rgba(124, 58, 237, 0.4), 0 0 0 1px rgba(167, 139, 250, 0.2) !important;
        }
        .ls-btn.active:hover {
          transform: none;
        }
      `}</style>
      {isMediaActive && (
        <div style={styles.mediaStatus} aria-live="polite">
          <span style={styles.mediaStatusLabel}>{getMediaShareLayoutLabel(currentLayout)}</span>
          <span style={styles.mediaStatusMeta}>{selectedMediaVisibilityLabel}</span>
          {selectedMediaSummary && selectedMediaSummary.hiddenParticipantCount > 0 && (
            <span style={styles.mediaHiddenBadge}>
              {selectedMediaSummary.hiddenParticipantCount} hidden
            </span>
          )}
          {recommendedMediaLayout && currentLayout === recommendedMediaLayout && (
            <span style={styles.mediaRecommendedBadge}>Best fit</span>
          )}
        </div>
      )}
      <div style={styles.controlRow}>
        <div style={styles.bar} role="radiogroup" aria-label={isMediaActive ? 'Shared media layout switcher' : 'Layout switcher'}>
          {STUDIO_LAYOUT_PRESET_ORDER.map((mode) => {
            const label = isMediaActive ? getMediaShareLayoutLabel(mode) : getStudioLayoutLabel(mode);
            const description = isMediaActive ? getMediaShareLayoutDescription(mode) : getStudioLayoutDescription(mode);
            const isActive = currentLayout === mode;
            const isRecommended = isMediaActive && recommendedMediaLayout === mode;
            const isDisabled = isMediaActive
              ? activeMediaParticipantCount < 1 && isMultiParticipantLayout(mode)
              : participantCount < 2 && isMultiParticipantLayout(mode);
            const mediaVisibilityTitle = isMediaActive
              ? ` ${formatMediaVisibilityTitle(mode, activeMediaParticipantCount)}`
              : '';
            const recommendationTitle = isRecommended ? ' Recommended for the current shared media.' : '';
            const disabledTitle = isMediaActive
              ? `${label} (Requires at least one person on stage)`
              : `${label} (Requires 2+ people)`;
            return (
              <button
                key={mode}
                className={`ls-btn ${isActive ? 'active' : ''}`}
                role="radio"
                aria-checked={isActive}
                aria-label={`${label} layout - ${description}${mediaVisibilityTitle}${recommendationTitle}`}
                onClick={() => onLayoutChange(mode)}
                disabled={isDisabled}
                title={isDisabled ? disabledTitle : `${label} - ${description}.${mediaVisibilityTitle}${recommendationTitle}`}
                style={{
                  ...styles.btn,
                  ...(isDisabled ? styles.btnDisabled : {}),
                  ...(isRecommended && !isActive ? styles.btnRecommended : {}),
                }}
              >
                {layoutIcons[mode]}
              </button>
            );
          })}
        </div>
        {isMediaActive && (
          <button
            style={{
              ...styles.bestFitButton,
              ...(!canApplyRecommendation ? styles.bestFitButtonDisabled : {}),
            }}
            disabled={!canApplyRecommendation}
            onClick={() => {
              if (recommendedMediaLayout) onLayoutChange(recommendedMediaLayout);
            }}
            title={canApplyRecommendation
              ? `Switch to ${recommendationLabel}, the recommended shared-media layout.`
              : `${recommendationLabel || 'Current layout'} is already the best fit.`}
          >
            Best fit
          </button>
        )}
      </div>
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
  mediaStatus: {
    maxWidth: '100%',
    minHeight: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '4px 9px',
    borderRadius: 999,
    border: '1px solid rgba(255, 255, 255, 0.10)',
    background: 'rgba(15, 23, 42, 0.66)',
    color: 'rgba(255, 255, 255, 0.84)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.22)',
  },
  mediaStatusLabel: {
    minWidth: 0,
    color: 'white',
    fontSize: 11,
    fontWeight: 800,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  mediaStatusMeta: {
    flexShrink: 0,
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: 10,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
  },
  mediaHiddenBadge: {
    flexShrink: 0,
    minHeight: 18,
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    border: '1px solid rgba(251, 191, 36, 0.24)',
    background: 'rgba(251, 191, 36, 0.10)',
    color: '#fde68a',
    padding: '0 6px',
    fontSize: 9,
    fontWeight: 900,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  mediaRecommendedBadge: {
    flexShrink: 0,
    minHeight: 18,
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    border: '1px solid rgba(34, 197, 94, 0.24)',
    background: 'rgba(34, 197, 94, 0.10)',
    color: '#bbf7d0',
    padding: '0 6px',
    fontSize: 9,
    fontWeight: 900,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
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
  btnRecommended: {
    color: 'var(--accent-hover)',
    boxShadow: 'inset 0 0 0 1px rgba(167, 139, 250, 0.38)',
  },
  btnActive: {
    background: 'var(--accent)',
    color: 'white',
    boxShadow: '0 1px 4px rgba(124, 58, 237, 0.3)',
  },
  btnDisabled: {
    opacity: 0.25,
    cursor: 'not-allowed',
  },
  bestFitButton: {
    minHeight: 32,
    borderRadius: 10,
    border: '1px solid rgba(167, 139, 250, 0.24)',
    background: 'rgba(167, 139, 250, 0.10)',
    color: 'var(--accent-hover)',
    padding: '0 10px',
    fontSize: 11,
    fontWeight: 900,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  bestFitButtonDisabled: {
    opacity: 0.46,
    cursor: 'not-allowed',
  },
};
