import type { LayoutMode } from '@studio/shared';

interface LayoutSwitcherProps {
  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  participantCount: number;
}

const layouts: { mode: LayoutMode; label: string; description: string; icon: React.ReactNode }[] = [
  {
    mode: 'grid',
    label: 'Grid',
    description: 'Auto-fit grid for 1-12 people',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    mode: 'spotlight',
    label: 'Spotlight',
    description: 'One large, others in strip below',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="16" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="6.75" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="12.5" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    mode: 'side-by-side',
    label: 'Side by Side',
    description: 'Two equal tiles, 50/50 split',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="9.5" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    mode: 'featured',
    label: 'Featured',
    description: '70% main + 30% side stack',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.5" y="2" width="3.5" height="14" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    mode: 'pip',
    label: 'PiP',
    description: 'Full screen + small overlay',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="10" width="6" height="5" rx="1" fill="currentColor" opacity="0.5" stroke="currentColor" strokeWidth="1" />
      </svg>
    ),
  },
  {
    mode: 'single',
    label: 'Single',
    description: 'Show only one participant',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
];

export function LayoutSwitcher({ currentLayout, onLayoutChange, participantCount }: LayoutSwitcherProps) {
  return (
    <div style={styles.bar}>
      {layouts.map(({ mode, label, description, icon }) => {
        const isActive = currentLayout === mode;
        const isDisabled = participantCount < 2 && (mode === 'side-by-side' || mode === 'pip' || mode === 'spotlight' || mode === 'featured');
        return (
          <button
            key={mode}
            onClick={() => onLayoutChange(mode)}
            disabled={isDisabled}
            title={`${label} — ${description}`}
            style={{
              ...styles.btn,
              ...(isActive ? styles.btnActive : {}),
              ...(isDisabled ? styles.btnDisabled : {}),
            }}
          >
            {icon}
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
