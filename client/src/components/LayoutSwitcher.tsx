import type { LayoutMode } from '@studio/shared';
import {
  getMediaShareLayoutDescription,
  getMediaShareLayoutLabel,
  getStudioLayoutDescription,
  getStudioLayoutLabel,
  isMultiParticipantLayout,
  STUDIO_LAYOUT_PRESET_ORDER,
} from '../utils/layoutPresets.ts';

interface LayoutSwitcherProps {
  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  participantCount: number;
  isMediaActive?: boolean;
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

export function LayoutSwitcher({ currentLayout, onLayoutChange, participantCount, isMediaActive = false }: LayoutSwitcherProps) {
  return (
    <div style={styles.bar} role="radiogroup" aria-label={isMediaActive ? 'Shared media layout switcher' : 'Layout switcher'}>
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
      {STUDIO_LAYOUT_PRESET_ORDER.map((mode) => {
        const label = isMediaActive ? getMediaShareLayoutLabel(mode) : getStudioLayoutLabel(mode);
        const description = isMediaActive ? getMediaShareLayoutDescription(mode) : getStudioLayoutDescription(mode);
        const isActive = currentLayout === mode;
        const isDisabled = participantCount < 2 && isMultiParticipantLayout(mode);
        return (
          <button
            key={mode}
            className={`ls-btn ${isActive ? 'active' : ''}`}
            role="radio"
            aria-checked={isActive}
            aria-label={`${label} layout - ${description}`}
            onClick={() => onLayoutChange(mode)}
            disabled={isDisabled}
            title={isDisabled ? `${label} (Requires 2+ people)` : `${label} - ${description}`}
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
  );
}

const styles: Record<string, React.CSSProperties> = {
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
  btnActive: {
    background: 'var(--accent)',
    color: 'white',
    boxShadow: '0 1px 4px rgba(124, 58, 237, 0.3)',
  },
  btnDisabled: {
    opacity: 0.25,
    cursor: 'not-allowed',
  },
};
