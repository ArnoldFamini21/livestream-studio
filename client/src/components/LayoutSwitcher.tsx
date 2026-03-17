import type { LayoutMode } from '@studio/shared';

interface LayoutSwitcherProps {
  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  participantCount: number;
}

const layouts: { mode: LayoutMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: 'grid',
    label: 'Grid',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
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
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
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
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="9.5" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    mode: 'pip',
    label: 'PiP',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="10" width="6" height="5" rx="1" fill="currentColor" opacity="0.5" stroke="currentColor" strokeWidth="1" />
      </svg>
    ),
  },
  {
    mode: 'single',
    label: 'Single',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    mode: 'featured',
    label: 'Featured',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.5" y="2" width="3.5" height="14" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
];

export function LayoutSwitcher({ currentLayout, onLayoutChange, participantCount }: LayoutSwitcherProps) {
  return (
    <div style={styles.container}>
      <span style={styles.label}>Layout</span>
      <div style={styles.options}>
        {layouts.map(({ mode, label, icon }) => {
          const isActive = currentLayout === mode;
          const isDisabled = participantCount < 2 && (mode === 'side-by-side' || mode === 'pip' || mode === 'spotlight' || mode === 'featured');
          return (
            <button
              key={mode}
              onClick={() => onLayoutChange(mode)}
              disabled={isDisabled}
              title={label}
              style={{
                ...styles.option,
                ...(isActive ? styles.optionActive : {}),
                ...(isDisabled ? styles.optionDisabled : {}),
              }}
            >
              {icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  options: {
    display: 'flex',
    gap: 2,
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 3,
    border: '1px solid var(--border)',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 30,
    borderRadius: 7,
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    transition: 'all var(--transition-fast)',
  },
  optionActive: {
    background: 'var(--accent)',
    color: 'white',
    boxShadow: '0 1px 4px rgba(124, 58, 237, 0.3)',
  },
  optionDisabled: {
    opacity: 0.3,
    cursor: 'not-allowed',
  },
};
