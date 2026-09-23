import type { PresentationCorner, PresentationCameraSize } from '../utils/presentationLayout.ts';
import '../styles/presentation.css';
import type { LayoutMode } from '@studio/shared';
import {
  getMediaShareLayoutDescription,
  getMediaShareLayoutLabel,
  getStudioLayoutDescription,
  getStudioLayoutLabel,
  isLayoutBarOptionDisabled,
  MEDIA_SHARE_LAYOUT_ORDER,
  MEDIA_SHARE_LAYOUT_SHORT_LABELS,
  STUDIO_LAYOUT_PRESET_ORDER,
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
  pipCorner?: PresentationCorner;
  cameraSize?: PresentationCameraSize;
  onCameraSizeChange?: (size: PresentationCameraSize) => void;
  onPipCornerChange?: (corner: PresentationCorner) => void;
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

const PRESENTER_SIZES: Array<{ value: PresentationCameraSize; label: string; short: string }> = [
  { value: 'small', label: 'Small', short: 'S' },
  { value: 'medium', label: 'Medium', short: 'M' },
  { value: 'large', label: 'Large', short: 'L' },
];
const PRESENTER_CORNERS: Array<{ value: PresentationCorner; label: string }> = [
  { value: 'TL', label: 'Top left' },
  { value: 'TR', label: 'Top right' },
  { value: 'BL', label: 'Bottom left' },
  { value: 'BR', label: 'Bottom right' },
];

/** Miniature of the broadcast: the light block is the content, accent blocks are presenters. */
function MediaLayoutGlyph({ mode }: { mode: LayoutMode }) {
  const content = (x: number, y: number, w: number, h: number) => <rect x={x} y={y} width={w} height={h} rx="1.5" fill="currentColor" opacity="0.55" />;
  const presenter = (x: number, y: number, w: number, h: number) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="1" className="presentation-glyph-presenter" />;
  const shapes: Record<LayoutMode, React.ReactNode> = {
    single: content(2, 2, 28, 16),
    grid: <>{content(2, 3, 19, 14)}{presenter(23, 7.5, 7, 5)}</>,
    spotlight: <>{content(6, 1.5, 20, 11)}{[7, 13.5, 20].map(x => presenter(x, 14, 5, 4))}</>,
    pip: <>{content(2, 2, 28, 16)}{presenter(21, 11.5, 7.5, 5)}</>,
    'side-by-side': <>{content(2, 4, 16, 12)}{presenter(19.5, 6, 10.5, 8)}</>,
    featured: <>{content(2, 2, 28, 16)}{presenter(23, 4, 5.5, 3.5)}{presenter(23, 8.5, 5.5, 3.5)}{presenter(23, 13, 5.5, 3.5)}</>,
  };
  return <svg width="32" height="20" viewBox="0 0 32 20" aria-hidden="true" className="presentation-glyph">
    <rect x="0.5" y="0.5" width="31" height="19" rx="3" fill="none" stroke="currentColor" opacity="0.35" />
    {shapes[mode]}
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
  pipCorner = 'BR',
  cameraSize = 'medium',
  onCameraSizeChange,
  onPipCornerChange,
}: LayoutSwitcherProps) {
  const activeMediaParticipantCount = normalizeCount(mediaParticipantCount ?? Math.max(0, participantCount - 1));

  if (isMediaActive) {
    const summary = getMediaShareLayoutVisibilitySummary(currentLayout, activeMediaParticipantCount);
    const showHiddenCount = currentLayout !== 'single' && summary.hiddenParticipantCount > 0;
    const hasPresenters = currentLayout !== 'single' && activeMediaParticipantCount > 0;
    const floating = currentLayout === 'pip' || currentLayout === 'featured';
    return <div className="presentation-layouts">
      <div className="presentation-layout-options" role="group" aria-label="Presentation layout">
        {MEDIA_SHARE_LAYOUT_ORDER.map((mode, index) => <button type="button" key={mode} aria-pressed={currentLayout === mode}
          aria-label={`${getMediaShareLayoutLabel(mode)} layout`}
          aria-keyshortcuts={String(index + 1)}
          title={`${getMediaShareLayoutDescription(mode)} (${index + 1})`}
          disabled={isLayoutBarOptionDisabled(mode, { isMediaActive: true, participantCount, mediaParticipantCount: activeMediaParticipantCount })}
          onClick={() => onLayoutChange(mode)}>
          <MediaLayoutGlyph mode={mode} />
          <span>{MEDIA_SHARE_LAYOUT_SHORT_LABELS[mode]}</span>
        </button>)}
      </div>
      {hasPresenters && (onCameraSizeChange || (floating && onPipCornerChange)) && <div className="presentation-layout-tuning">
        {onCameraSizeChange && <div className="presentation-segment" role="group" aria-label="Presenter size">
          {PRESENTER_SIZES.map(option => <button type="button" key={option.value} aria-pressed={cameraSize === option.value}
            aria-label={`${option.label} presenter`} title={`${option.label} presenter`} onClick={() => onCameraSizeChange(option.value)}>
            {option.short}
          </button>)}
        </div>}
        {floating && onPipCornerChange && <div className="presentation-corners" role="group" aria-label="Presenter position">
          {PRESENTER_CORNERS.map(option => <button type="button" key={option.value} aria-pressed={pipCorner === option.value}
            aria-label={option.label} title={option.label} onClick={() => onPipCornerChange(option.value)}>
            <span />
          </button>)}
        </div>}
        {showHiddenCount && <span className="presentation-layout-hint">{formatMediaVisibilityLabel(currentLayout, activeMediaParticipantCount)}</span>}
      </div>}
    </div>;
  }

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
      <div style={styles.controlRow}>
        <div style={styles.bar} role="radiogroup" aria-label="Layout switcher">
          {STUDIO_LAYOUT_PRESET_ORDER.map((mode, index) => {
            const label = getStudioLayoutLabel(mode);
            const description = getStudioLayoutDescription(mode);
            const isActive = currentLayout === mode;
            const isDisabled = isLayoutBarOptionDisabled(mode, { isMediaActive: false, participantCount });
            return (
              <button
                key={mode}
                className={`ls-btn ${isActive ? 'active' : ''}`}
                role="radio"
                aria-checked={isActive}
                aria-label={`${label} layout - ${description}`}
                onClick={() => onLayoutChange(mode)}
                disabled={isDisabled}
                aria-keyshortcuts={String(index + 1)}
                title={isDisabled ? `${label} (Requires 2+ people)` : `${label} - ${description} (${index + 1})`}
                style={{
                  ...styles.btn,
                  ...(isDisabled ? styles.btnDisabled : {}),
                }}
              >
                {layoutIcons[mode]}
              </button>
            );
          })}
        </div>
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
