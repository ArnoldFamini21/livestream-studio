import { useState, useEffect, useRef } from 'react';
import type { Participant } from '@studio/shared';
import {
  getLowerThirdAnimationLabel,
  getLowerThirdAnimationStyle,
  getParticipantLowerThirdTitle,
  LOWER_THIRD_ANIMATION_EXIT_MS,
  LOWER_THIRD_ANIMATION_PRESETS,
  normalizeLowerThirdAccentColor,
  normalizeLowerThirdAnimation,
  type LowerThirdAnimation,
} from '../utils/lowerThirds.ts';

export interface LowerThirdData {
  id: string;
  name: string;
  title: string;
  style: 'minimal' | 'bold' | 'gradient' | 'glass';
  visible: boolean;
  durationSeconds?: number;
  accentColor?: string;
  animation?: LowerThirdAnimation;
  source?: 'auto-speaker' | 'participant';
  participantId?: string;
}

interface LowerThirdManagerProps {
  lowerThirds: LowerThirdData[];
  participants?: Participant[];
  onAdd: (lt: Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  autoSpeakerEnabled?: boolean;
  onAutoSpeakerEnabledChange?: (enabled: boolean) => void;
}

const LOWER_THIRD_DURATION_OPTIONS = [
  { label: 'Manual', value: 0 },
  { label: '10s', value: 10 },
  { label: '20s', value: 20 },
  { label: '60s', value: 60 },
] as const;

const LOWER_THIRD_ACCENT_COLORS = [
  '#7c3aed',
  '#0891b2',
  '#059669',
  '#db2777',
  '#ea580c',
  '#2563eb',
] as const;

export function LowerThirdManager({
  lowerThirds,
  participants = [],
  onAdd,
  onToggle,
  onRemove,
  autoSpeakerEnabled = false,
  onAutoSpeakerEnabledChange,
}: LowerThirdManagerProps) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<LowerThirdData['style']>('minimal');
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [accentColor, setAccentColor] = useState('');
  const [animation, setAnimation] = useState<LowerThirdAnimation>('slide');
  const onStageParticipants = participants.filter((participant) => participant.status === 'on-stage');

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd({
      name: name.trim(),
      title: title.trim(),
      style,
      durationSeconds: durationSeconds || undefined,
      accentColor: normalizeLowerThirdAccentColor(accentColor),
      animation,
    });
    setName('');
    setTitle('');
  };

  return (
    <div style={styles.container}>
      <h4 style={styles.sectionTitle}>Lower Thirds</h4>

      {onAutoSpeakerEnabledChange && (
        <div style={styles.autoSpeakerBlock}>
          <div style={styles.autoSpeakerText}>
            <span style={styles.autoSpeakerTitle}>Auto Speaker</span>
            <span style={styles.autoSpeakerState}>{autoSpeakerEnabled ? 'On' : 'Off'}</span>
          </div>
          <button
            type="button"
            aria-pressed={autoSpeakerEnabled}
            style={{
              ...styles.autoSpeakerToggle,
              ...(autoSpeakerEnabled ? styles.autoSpeakerToggleActive : {}),
            }}
            onClick={() => onAutoSpeakerEnabledChange(!autoSpeakerEnabled)}
          >
            {autoSpeakerEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      )}

      {onStageParticipants.length > 0 && (
        <div style={styles.quickBlock}>
          <div style={styles.quickHeader}>
            <span style={styles.quickTitle}>On-Stage Names</span>
            <span style={styles.quickCount}>{onStageParticipants.length}</span>
          </div>
          <div style={styles.quickList}>
            {onStageParticipants.map((participant) => (
              <button
                key={participant.id}
                type="button"
                style={styles.quickParticipantBtn}
                onClick={() => onAdd({
                  name: participant.name,
                  title: getParticipantLowerThirdTitle(participant.role),
                  style: 'bold',
                  durationSeconds: 10,
                  animation: 'slide',
                  visible: true,
                  source: 'participant',
                  participantId: participant.id,
                })}
                aria-label={`Show lower third for ${participant.name}`}
                title={`Show lower third for ${participant.name}`}
              >
                <span style={styles.quickParticipantName}>{participant.name}</span>
                <span style={styles.quickParticipantRole}>{getParticipantLowerThirdTitle(participant.role)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Existing lower thirds */}
      <div style={styles.list}>
        {lowerThirds.map((lt) => (
          <div key={lt.id} className="participant-item" style={styles.item}>
            <div style={styles.itemInfo}>
              <div style={styles.itemNameRow}>
                <span
                  style={{
                    ...styles.itemDot,
                    background: normalizeLowerThirdAccentColor(lt.accentColor) || 'var(--accent)',
                  }}
                />
                <span style={styles.itemName}>{lt.name}</span>
              </div>
              {lt.title && <span style={styles.itemTitle}>{lt.title}</span>}
              <div style={styles.itemMetaRow}>
                {lt.source === 'auto-speaker' && <span style={styles.itemMeta}>auto speaker</span>}
                {lt.durationSeconds && <span style={styles.itemMeta}>{lt.durationSeconds}s auto-hide</span>}
                <span style={styles.itemMeta}>{getLowerThirdAnimationLabel(lt.animation)}</span>
              </div>
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
              <button className="participant-action-btn" style={styles.removeBtn} onClick={() => onRemove(lt.id)}>
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
        <div style={styles.durationGroup}>
          <span style={styles.durationLabel}>Duration</span>
          <div style={styles.durationRow}>
            {LOWER_THIRD_DURATION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                style={{
                  ...styles.durationBtn,
                  ...(durationSeconds === option.value ? styles.durationBtnActive : {}),
                }}
                onClick={() => setDurationSeconds(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div style={styles.durationGroup}>
          <span style={styles.durationLabel}>Animation</span>
          <div style={styles.durationRow}>
            {LOWER_THIRD_ANIMATION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                style={{
                  ...styles.durationBtn,
                  ...(animation === preset.id ? styles.durationBtnActive : {}),
                }}
                onClick={() => setAnimation(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div style={styles.accentGroup}>
          <span style={styles.durationLabel}>Accent</span>
          <div style={styles.accentRow}>
            <button
              type="button"
              style={{
                ...styles.accentBrandBtn,
                ...(accentColor === '' ? styles.accentBrandBtnActive : {}),
              }}
              onClick={() => setAccentColor('')}
            >
              Brand
            </button>
            {LOWER_THIRD_ACCENT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                style={{
                  ...styles.accentSwatch,
                  background: color,
                  outline: accentColor === color ? `2px solid ${color}` : 'none',
                  outlineOffset: 2,
                }}
                onClick={() => setAccentColor(color)}
                aria-label={`Use ${color} accent`}
                title={color}
              />
            ))}
          </div>
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
  const [mounted, setMounted] = useState(true);
  const [animatingIn, setAnimatingIn] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animation = normalizeLowerThirdAnimation(data.animation);

  useEffect(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (data.visible) {
      setMounted(true);
      // Allow the DOM to render before triggering the enter animation
      const frame = requestAnimationFrame(() => setAnimatingIn(true));
      return () => {
        cancelAnimationFrame(frame);
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      };
    } else {
      // Start exit animation, then unmount
      setAnimatingIn(false);
      exitTimerRef.current = setTimeout(() => setMounted(false), LOWER_THIRD_ANIMATION_EXIT_MS);
    }

    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, [animation, data.visible]);

  if (!mounted) return null;

  const overlayStyles = getOverlayStyle(data.style, normalizeLowerThirdAccentColor(data.accentColor));
  const animationStyle = getLowerThirdAnimationStyle(animation, animatingIn);

  return (
    <div
      aria-live="polite"
      role="status"
      style={{
        ...overlayBase,
        ...overlayStyles.container,
        ...animationStyle,
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

function getOverlayStyle(style: LowerThirdData['style'], accentColor?: string) {
  const accent = accentColor || 'var(--accent)';
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
        nameBar: { ...base.nameBar, borderLeft: `3px solid ${accent}` },
      };
    case 'bold':
      return {
        ...base,
        container: { overflow: 'hidden', borderRadius: 8 },
        nameBar: { ...base.nameBar, background: accent, padding: '8px 18px' },
        name: { ...base.name, fontSize: 16, letterSpacing: '0.02em' },
        titleBar: { ...base.titleBar, background: 'rgba(0,0,0,0.8)', padding: '6px 18px' },
      };
    case 'gradient':
      return {
        ...base,
        container: { background: `linear-gradient(135deg, ${accentColor || '#7c3aed'}, #ec4899)`, borderRadius: 10, overflow: 'hidden' },
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
          border: accentColor ? `1px solid ${accentColor}` : '1px solid rgba(255,255,255,0.15)',
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
  autoSpeakerBlock: {
    margin: '0 12px 12px',
    minHeight: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '7px 9px',
    borderRadius: 7,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(167, 139, 250, 0.24)',
    background: 'rgba(167, 139, 250, 0.08)',
  },
  autoSpeakerText: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  autoSpeakerTitle: {
    fontSize: 12,
    fontWeight: 800,
    color: 'var(--text-primary)',
  },
  autoSpeakerState: {
    fontSize: 9,
    fontWeight: 800,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  autoSpeakerToggle: {
    minWidth: 42,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: '0.04em',
    cursor: 'pointer',
  },
  autoSpeakerToggleActive: {
    borderColor: 'var(--success)',
    background: 'rgba(34, 197, 94, 0.14)',
    color: '#86efac',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 12px',
    marginBottom: 12,
  },
  quickBlock: {
    padding: '0 12px 12px',
  },
  quickHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  quickTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  quickCount: {
    minWidth: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    background: 'rgba(167, 139, 250, 0.14)',
    color: '#c4b5fd',
    fontSize: 10,
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
  },
  quickList: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 5,
  },
  quickParticipantBtn: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 34,
    padding: '6px 9px',
    borderRadius: 7,
    border: '1px solid rgba(167, 139, 250, 0.24)',
    background: 'rgba(167, 139, 250, 0.08)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  quickParticipantName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontWeight: 700,
  },
  quickParticipantRole: {
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 800,
    color: '#c4b5fd',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
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
  itemNameRow: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  itemDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  itemName: {
    minWidth: 0,
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
  itemMeta: {
    width: 'fit-content',
    padding: '1px 5px',
    borderRadius: 4,
    background: 'rgba(167, 139, 250, 0.12)',
    color: '#c4b5fd',
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  itemMetaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 3,
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
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    cursor: 'pointer',
    textTransform: 'capitalize',
  },
  styleBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent-hover)',
    borderColor: 'var(--accent)',
  },
  durationGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
  },
  durationLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  durationRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 4,
  },
  durationBtn: {
    minWidth: 0,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
  },
  durationBtnActive: {
    background: 'rgba(167, 139, 250, 0.14)',
    borderColor: 'var(--accent)',
    color: '#c4b5fd',
  },
  accentGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
  },
  accentRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  accentBrandBtn: {
    height: 24,
    padding: '0 8px',
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
  },
  accentBrandBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    color: 'var(--accent-hover)',
  },
  accentSwatch: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  addBtn: {
    fontSize: 12,
    padding: '7px 12px',
  },
};
