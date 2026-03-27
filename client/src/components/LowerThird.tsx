import { useState, useEffect, useRef } from 'react';

interface LowerThirdData {
  id: string;
  name: string;
  title: string;
  style: 'minimal' | 'bold' | 'gradient' | 'glass';
  visible: boolean;
}

interface LowerThirdManagerProps {
  lowerThirds: LowerThirdData[];
  onAdd: (lt: Omit<LowerThirdData, 'id' | 'visible'>) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

export function LowerThirdManager({ lowerThirds, onAdd, onToggle, onRemove }: LowerThirdManagerProps) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<LowerThirdData['style']>('minimal');

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), title: title.trim(), style });
    setName('');
    setTitle('');
  };

  return (
    <div style={styles.container}>
      <h4 style={styles.sectionTitle}>Lower Thirds</h4>

      {/* Existing lower thirds */}
      <div style={styles.list}>
        {lowerThirds.map((lt) => (
          <div key={lt.id} className="participant-item" style={styles.item}>
            <div style={styles.itemInfo}>
              <span style={styles.itemName}>{lt.name}</span>
              {lt.title && <span style={styles.itemTitle}>{lt.title}</span>}
            </div>
            <div style={styles.itemActions}>
              <button
                style={{
                  ...styles.toggleBtn,
                  background: lt.visible ? 'var(--success)' : 'var(--bg-surface)',
                  color: lt.visible ? 'white' : 'var(--text-muted)',
                }}
                onClick={() => onToggle(lt.id)}
              >
                {lt.visible ? 'ON' : 'OFF'}
              </button>
              <button style={styles.removeBtn} onClick={() => onRemove(lt.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add new */}
      <div style={styles.form}>
        <input
          style={styles.input}
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div style={styles.styleRow}>
          {(['minimal', 'bold', 'gradient', 'glass'] as const).map((s) => (
            <button
              key={s}
              style={{
                ...styles.styleBtn,
                ...(style === s ? styles.styleBtnActive : {}),
              }}
              onClick={() => setStyle(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          className="btn-primary"
          style={styles.addBtn}
          onClick={handleAdd}
          disabled={!name.trim()}
        >
          Add Lower Third
        </button>
      </div>
    </div>
  );
}

// The actual on-screen overlay component
export function LowerThirdOverlay({ data }: { data: LowerThirdData }) {
  const [mounted, setMounted] = useState(data.visible);
  const [animatingIn, setAnimatingIn] = useState(data.visible);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (data.visible) {
      setMounted(true);
      // Allow the DOM to render before triggering the enter animation
      requestAnimationFrame(() => setAnimatingIn(true));
    } else {
      // Start exit animation, then unmount
      setAnimatingIn(false);
      exitTimerRef.current = setTimeout(() => setMounted(false), 400);
    }

    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, [data.visible]);

  if (!mounted) return null;

  const overlayStyles = getOverlayStyle(data.style);

  return (
    <div
      aria-live="polite"
      role="status"
      style={{
        ...overlayBase,
        ...overlayStyles.container,
        opacity: animatingIn ? 1 : 0,
        transform: animatingIn ? 'translateY(0)' : 'translateY(16px)',
        transition: 'opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div style={overlayStyles.nameBar}>
        <span style={overlayStyles.name}>{data.name}</span>
      </div>
      {data.title && (
        <div style={overlayStyles.titleBar}>
          <span style={overlayStyles.title}>{data.title}</span>
        </div>
      )}
    </div>
  );
}

function getOverlayStyle(style: LowerThirdData['style']) {
  const base = {
    container: {} as React.CSSProperties,
    nameBar: { padding: '6px 16px' } as React.CSSProperties,
    name: { fontSize: 15, fontWeight: 700, color: 'white' } as React.CSSProperties,
    titleBar: { padding: '4px 16px' } as React.CSSProperties,
    title: { fontSize: 12, color: 'rgba(255,255,255,0.8)' } as React.CSSProperties,
  };

  switch (style) {
    case 'minimal':
      return {
        ...base,
        container: { background: 'rgba(0,0,0,0.75)', borderRadius: 8, overflow: 'hidden' },
        nameBar: { ...base.nameBar, borderLeft: '3px solid var(--accent)' },
      };
    case 'bold':
      return {
        ...base,
        container: { overflow: 'hidden', borderRadius: 8 },
        nameBar: { ...base.nameBar, background: 'var(--accent)', padding: '8px 18px' },
        name: { ...base.name, fontSize: 16, letterSpacing: '0.02em' },
        titleBar: { ...base.titleBar, background: 'rgba(0,0,0,0.8)', padding: '6px 18px' },
      };
    case 'gradient':
      return {
        ...base,
        container: { background: 'linear-gradient(135deg, #7c3aed, #ec4899)', borderRadius: 10, overflow: 'hidden' },
        nameBar: { ...base.nameBar, padding: '8px 18px' },
        titleBar: { ...base.titleBar, background: 'rgba(0,0,0,0.2)' },
      };
    case 'glass':
      return {
        ...base,
        container: {
          background: 'rgba(255,255,255,0.1)',
          backdropFilter: 'blur(16px)',
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.15)',
          overflow: 'hidden',
        },
        nameBar: { ...base.nameBar, padding: '8px 16px' },
      };
  }
}

const overlayBase: React.CSSProperties = {
  position: 'absolute',
  bottom: 60,
  left: 24,
  zIndex: 10,
  maxWidth: 320,
  filter: 'drop-shadow(0 8px 20px rgba(0, 0, 0, 0.4))',
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 0',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '0 16px',
    marginBottom: 8,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 12px',
    marginBottom: 12,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: 'var(--bg-tertiary)',
    borderRadius: 8,
    gap: 8,
  },
  itemInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    minWidth: 0,
    flex: 1,
  },
  itemName: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemTitle: {
    fontSize: 11,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  toggleBtn: {
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: 4,
    border: 'none',
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  form: {
    padding: '0 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  input: {
    width: '100%',
    padding: '7px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
  },
  styleRow: {
    display: 'flex',
    gap: 4,
  },
  styleBtn: {
    flex: 1,
    fontSize: 10,
    fontWeight: 500,
    padding: '5px 0',
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    textTransform: 'capitalize',
  },
  styleBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent-hover)',
    borderColor: 'var(--accent)',
  },
  addBtn: {
    fontSize: 12,
    padding: '7px 12px',
  },
};

export type { LowerThirdData };
