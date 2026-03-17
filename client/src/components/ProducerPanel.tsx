import { useState, useMemo, useRef, useEffect } from 'react';
import type { Participant, ParticipantStatus, LayoutMode, StageActionPayload } from '@studio/shared';

interface ProducerPanelProps {
  participants: Map<string, Participant>;
  myParticipantId: string;
  remoteStreams: Map<string, MediaStream>;
  localStream: MediaStream | null;

  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;

  isLive: boolean;
  isRecording: boolean;
  formattedTime: string;

  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;

  onClose: () => void;
}

// ============ Layout icon data ============

const layoutOptions: { mode: LayoutMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: 'grid',
    label: 'Grid',
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
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="9.5" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    mode: 'pip',
    label: 'PiP',
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
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    mode: 'featured',
    label: 'Featured',
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.5" y="2" width="3.5" height="14" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
];

// ============ Helpers ============

function nameToGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash % 360);
  const h2 = (h1 + 40) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 60%, 35%), hsl(${h2}, 50%, 25%))`;
}

function getStatusColor(status: ParticipantStatus): string {
  switch (status) {
    case 'on-stage': return 'var(--success)';
    case 'green-room': return 'var(--warning, #f59e0b)';
    case 'backstage': return 'var(--text-muted)';
  }
}

function getStatusLabel(status: ParticipantStatus): string {
  switch (status) {
    case 'on-stage': return 'On Stage';
    case 'green-room': return 'Green Room';
    case 'backstage': return 'Backstage';
  }
}

// ============ Sub-components ============

function MiniVideoTile({ stream, name, videoEnabled }: { stream: MediaStream | null; name: string; videoEnabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const initials = (name || '?')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

  return (
    <div style={miniTileStyles.tile}>
      {stream && videoEnabled ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={miniTileStyles.video}
        />
      ) : (
        <div style={{ ...miniTileStyles.placeholder, background: nameToGradient(name) }}>
          <span style={miniTileStyles.initials}>{initials}</span>
        </div>
      )}
      <div style={miniTileStyles.nameOverlay}>
        <span style={miniTileStyles.nameText}>{name}</span>
      </div>
    </div>
  );
}

function ParticipantRow({
  participant,
  isMe,
  onStageAction,
}: {
  participant: Participant;
  isMe: boolean;
  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;
}) {
  const initial = participant.name.charAt(0).toUpperCase();

  return (
    <div style={rowStyles.row}>
      <div style={rowStyles.left}>
        <div style={rowStyles.avatar}>{initial}</div>
        <div style={rowStyles.info}>
          <div style={rowStyles.nameRow}>
            <span style={rowStyles.name}>
              {participant.name}
              {isMe && <span style={rowStyles.youTag}> (You)</span>}
            </span>
          </div>
          <div style={rowStyles.meta}>
            <span
              style={{
                ...rowStyles.statusDot,
                background: getStatusColor(participant.status),
              }}
            />
            <span style={rowStyles.statusText}>{getStatusLabel(participant.status)}</span>
            {participant.role !== 'guest' && (
              <span style={rowStyles.roleBadge}>{participant.role}</span>
            )}
            {!participant.audioEnabled && <span style={rowStyles.muteBadge}>muted</span>}
            {!participant.videoEnabled && <span style={rowStyles.muteBadge}>cam off</span>}
          </div>
        </div>
      </div>

      {!isMe && participant.role !== 'host' && (
        <div style={rowStyles.actions}>
          {(participant.status === 'backstage' || participant.status === 'green-room') && (
            <button
              style={{ ...rowStyles.actionBtn, color: 'var(--success)', borderColor: 'rgba(34, 197, 94, 0.25)' }}
              onClick={() => onStageAction('move-to-stage', participant.id)}
              title="Bring to Stage"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="17 11 12 6 7 11" />
                <line x1="12" y1="6" x2="12" y2="18" />
              </svg>
              Stage
            </button>
          )}
          {participant.status === 'on-stage' && (
            <button
              style={{ ...rowStyles.actionBtn, color: 'var(--warning, #f59e0b)', borderColor: 'rgba(245, 158, 11, 0.25)' }}
              onClick={() => onStageAction('move-to-backstage', participant.id)}
              title="Move Backstage"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="7 13 12 18 17 13" />
                <line x1="12" y1="18" x2="12" y2="6" />
              </svg>
              Off
            </button>
          )}
          {participant.status === 'on-stage' && participant.audioEnabled && (
            <button
              style={{ ...rowStyles.actionBtn, color: 'var(--text-muted)', borderColor: 'var(--border)' }}
              onClick={() => onStageAction('mute', participant.id)}
              title="Mute"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
              </svg>
            </button>
          )}
          <button
            style={{ ...rowStyles.actionBtn, color: 'var(--danger)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
            onClick={() => onStageAction('remove', participant.id)}
            title="Remove from session"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// ============ Main Component ============

export function ProducerPanel({
  participants,
  myParticipantId,
  remoteStreams,
  localStream,
  onStageAction,
  isLive,
  isRecording,
  formattedTime,
  currentLayout,
  onLayoutChange,
  onClose,
}: ProducerPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Derive participant lists
  const { onStage, allParticipants, counts } = useMemo(() => {
    const onStageList: Participant[] = [];
    const allList: Participant[] = [];
    let onStageCount = 0;
    let greenRoomCount = 0;
    let backstageCount = 0;

    for (const [, p] of participants) {
      allList.push(p);
      if (p.status === 'on-stage') {
        onStageList.push(p);
        onStageCount++;
      } else if (p.status === 'green-room') {
        greenRoomCount++;
      } else {
        backstageCount++;
      }
    }

    return {
      onStage: onStageList,
      allParticipants: allList,
      counts: { onStage: onStageCount, greenRoom: greenRoomCount, backstage: backstageCount, total: allList.length },
    };
  }, [participants]);

  // Filtered participants for the right panel
  const filteredParticipants = useMemo(() => {
    if (!searchQuery.trim()) return allParticipants;
    const q = searchQuery.toLowerCase();
    return allParticipants.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q) ||
        p.role.toLowerCase().includes(q)
    );
  }, [allParticipants, searchQuery]);

  // Sort: on-stage first, then green-room, then backstage
  const sortedParticipants = useMemo(() => {
    const statusOrder: Record<ParticipantStatus, number> = {
      'on-stage': 0,
      'green-room': 1,
      'backstage': 2,
    };
    return [...filteredParticipants].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
  }, [filteredParticipants]);

  // Resolve stream for a participant
  const getStream = (participantId: string): MediaStream | null => {
    if (participantId === myParticipantId) return localStream;
    return remoteStreams.get(participantId) ?? null;
  };

  return (
    <div style={styles.overlay}>
      {/* ====== Top Bar ====== */}
      <div style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <div style={styles.titleGroup}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span style={styles.title}>Producer Mode</span>
            <span style={styles.badge}>PRODUCER</span>
          </div>
          <div style={styles.indicators}>
            {isLive && (
              <span style={styles.liveIndicator}>
                <span style={styles.liveDot} />
                LIVE
              </span>
            )}
            {isRecording && (
              <span style={styles.recIndicator}>
                <span style={styles.recDot} />
                REC {formattedTime}
              </span>
            )}
          </div>
        </div>
        <button style={styles.closeBtn} onClick={onClose} title="Exit Producer Mode">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          <span style={styles.closeBtnText}>Exit</span>
        </button>
      </div>

      {/* ====== Main Content ====== */}
      <div style={styles.main}>
        {/* ====== Left Panel (Stage Preview + Layout) ====== */}
        <div style={styles.leftPanel}>
          {/* Stage Preview */}
          <div style={styles.previewSection}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionTitle}>Stage Preview</span>
              <span style={styles.sectionBadge}>{onStage.length} on stage</span>
            </div>
            <div style={styles.previewArea}>
              {onStage.length === 0 ? (
                <div style={styles.emptyPreview}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.4 }}>
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  <span style={styles.emptyText}>No participants on stage</span>
                  <span style={styles.emptySubtext}>Bring participants from the list to start</span>
                </div>
              ) : (
                <div
                  style={{
                    ...styles.previewGrid,
                    gridTemplateColumns:
                      onStage.length === 1
                        ? '1fr'
                        : onStage.length <= 4
                          ? 'repeat(2, 1fr)'
                          : 'repeat(3, 1fr)',
                  }}
                >
                  {onStage.map((p) => (
                    <MiniVideoTile
                      key={p.id}
                      stream={getStream(p.id)}
                      name={p.name}
                      videoEnabled={p.videoEnabled}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Layout Selector */}
          <div style={styles.layoutSection}>
            <span style={styles.sectionTitle}>Layout</span>
            <div style={styles.layoutGrid}>
              {layoutOptions.map(({ mode, label, icon }) => {
                const isActive = currentLayout === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => onLayoutChange(mode)}
                    title={label}
                    style={{
                      ...styles.layoutBtn,
                      ...(isActive ? styles.layoutBtnActive : {}),
                    }}
                  >
                    {icon}
                    <span style={styles.layoutLabel}>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ====== Right Panel (Participants) ====== */}
        <div style={styles.rightPanel}>
          <div style={styles.participantHeader}>
            <span style={styles.sectionTitle}>All Participants</span>
            <span style={styles.sectionBadge}>{counts.total}</span>
          </div>

          {/* Search / Filter */}
          <div style={styles.searchWrapper}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={styles.searchIcon}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search participants..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={styles.searchInput}
            />
            {searchQuery && (
              <button style={styles.searchClear} onClick={() => setSearchQuery('')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          {/* Status summary pills */}
          <div style={styles.statusSummary}>
            <span style={styles.statusPill}>
              <span style={{ ...styles.statusPillDot, background: 'var(--success)' }} />
              {counts.onStage} on stage
            </span>
            <span style={styles.statusPill}>
              <span style={{ ...styles.statusPillDot, background: 'var(--warning, #f59e0b)' }} />
              {counts.greenRoom} waiting
            </span>
            <span style={styles.statusPill}>
              <span style={{ ...styles.statusPillDot, background: 'var(--text-muted)' }} />
              {counts.backstage} backstage
            </span>
          </div>

          {/* Participant list */}
          <div style={styles.participantList}>
            {sortedParticipants.length === 0 ? (
              <div style={styles.emptyList}>
                <span style={styles.emptyText}>No matching participants</span>
              </div>
            ) : (
              sortedParticipants.map((p) => (
                <ParticipantRow
                  key={p.id}
                  participant={p}
                  isMe={p.id === myParticipantId}
                  onStageAction={onStageAction}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* ====== Bottom Status Bar ====== */}
      <div style={styles.bottomBar}>
        <div style={styles.bottomLeft}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span style={styles.bottomText}>
            {counts.total} participant{counts.total !== 1 ? 's' : ''} in session
          </span>
          <span style={styles.bottomSep} />
          <span style={styles.bottomText}>{counts.onStage} on stage</span>
        </div>
        <div style={styles.bottomRight}>
          {isLive && (
            <span style={styles.bottomLive}>
              <span style={styles.liveDot} />
              LIVE
            </span>
          )}
          {isRecording && (
            <span style={styles.bottomRec}>
              <span style={styles.recDot} />
              {formattedTime}
            </span>
          )}
          {!isLive && !isRecording && (
            <span style={styles.bottomIdle}>Not broadcasting</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ Styles ============

const styles: Record<string, React.CSSProperties> = {
  // Overlay container — full-screen
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
  },

  // Top bar
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  topBarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-primary)',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.01em',
  },
  badge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 4,
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  indicators: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  liveIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
    color: '#ef4444',
    padding: '3px 10px',
    borderRadius: 6,
    background: 'rgba(239, 68, 68, 0.12)',
    letterSpacing: '0.04em',
  },
  recIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--warning, #f59e0b)',
    padding: '3px 10px',
    borderRadius: 6,
    background: 'rgba(245, 158, 11, 0.12)',
    fontFamily: 'monospace',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#ef4444',
    flexShrink: 0,
  },
  recDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--warning, #f59e0b)',
    flexShrink: 0,
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  closeBtnText: {
    fontSize: 12,
  },

  // Main body
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
  },

  // Left panel
  leftPanel: {
    width: '60%',
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid var(--border)',
    overflow: 'hidden',
  },
  previewSection: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: 16,
    minHeight: 0,
    overflow: 'hidden',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  sectionBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
  },
  previewArea: {
    flex: 1,
    background: 'var(--bg-tertiary)',
    borderRadius: 12,
    border: '1px solid var(--border)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
  },
  emptyPreview: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-muted)',
  },
  emptyText: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-muted)',
  },
  emptySubtext: {
    fontSize: 11,
    color: 'var(--text-muted)',
    opacity: 0.6,
  },
  previewGrid: {
    display: 'grid',
    gap: 6,
    padding: 8,
    width: '100%',
    height: '100%',
    alignContent: 'center',
  },
  layoutSection: {
    padding: '12px 16px 14px',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  layoutGrid: {
    display: 'flex',
    gap: 4,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  layoutBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '8px 12px',
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    minWidth: 56,
  },
  layoutBtnActive: {
    background: 'var(--accent)',
    color: 'white',
    borderColor: 'var(--accent)',
    boxShadow: '0 1px 6px rgba(124, 58, 237, 0.3)',
  },
  layoutLabel: {
    fontSize: 9,
    fontWeight: 500,
    letterSpacing: '0.02em',
  },

  // Right panel
  rightPanel: {
    width: '40%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--bg-secondary)',
  },
  participantHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px 0',
    flexShrink: 0,
  },
  searchWrapper: {
    position: 'relative',
    margin: '10px 16px 0',
    flexShrink: 0,
  },
  searchIcon: {
    position: 'absolute',
    left: 10,
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'var(--text-muted)',
    pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '8px 32px 8px 32px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box',
  },
  searchClear: {
    position: 'absolute',
    right: 6,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
  },
  statusSummary: {
    display: 'flex',
    gap: 8,
    padding: '8px 16px',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  statusPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10,
    fontWeight: 500,
    color: 'var(--text-muted)',
    padding: '3px 8px',
    borderRadius: 10,
    background: 'var(--bg-tertiary)',
  },
  statusPillDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  participantList: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  emptyList: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },

  // Bottom bar
  bottomBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 20px',
    background: 'var(--bg-secondary)',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  bottomLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-muted)',
  },
  bottomText: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-muted)',
  },
  bottomSep: {
    width: 1,
    height: 12,
    background: 'var(--border)',
  },
  bottomRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  bottomLive: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: 700,
    color: '#ef4444',
    letterSpacing: '0.04em',
  },
  bottomRec: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--warning, #f59e0b)',
    fontFamily: 'monospace',
  },
  bottomIdle: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
};

const miniTileStyles: Record<string, React.CSSProperties> = {
  tile: {
    position: 'relative',
    borderRadius: 8,
    overflow: 'hidden',
    aspectRatio: '16 / 9',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontSize: 16,
    fontWeight: 700,
    color: 'rgba(255, 255, 255, 0.8)',
    userSelect: 'none',
  },
  nameOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '2px 6px 3px',
    background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.6))',
  },
  nameText: {
    fontSize: 10,
    fontWeight: 600,
    color: 'rgba(255, 255, 255, 0.9)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'block',
  },
};

const rowStyles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '7px 10px',
    background: 'var(--bg-tertiary)',
    borderRadius: 8,
    gap: 6,
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    flex: 1,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'var(--bg-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    flexShrink: 0,
  },
  info: {
    minWidth: 0,
    flex: 1,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  name: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  youTag: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontWeight: 400,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  },
  statusText: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  roleBadge: {
    fontSize: 8,
    fontWeight: 600,
    padding: '0px 4px',
    borderRadius: 3,
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  muteBadge: {
    fontSize: 8,
    fontWeight: 500,
    padding: '0px 4px',
    borderRadius: 3,
    background: 'rgba(239, 68, 68, 0.1)',
    color: '#ef4444',
  },
  actions: {
    display: 'flex',
    gap: 3,
    flexShrink: 0,
  },
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    fontSize: 10,
    fontWeight: 600,
    padding: '3px 7px',
    borderRadius: 5,
    background: 'transparent',
    border: '1px solid',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
