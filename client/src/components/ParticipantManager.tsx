import type { Participant, ParticipantStatus, StageActionPayload } from '@studio/shared';

interface ParticipantManagerProps {
  participants: Map<string, Participant>;
  myParticipantId: string;
  myRole: 'host' | 'co-host' | 'guest';
  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;
  onClose: () => void;
}

export function ParticipantManager({
  participants,
  myParticipantId,
  myRole,
  onStageAction,
  onClose,
}: ParticipantManagerProps) {
  const isHostOrCoHost = myRole === 'host' || myRole === 'co-host';

  const grouped: Record<ParticipantStatus, Participant[]> = {
    'on-stage': [],
    'backstage': [],
    'green-room': [],
  };

  for (const [, p] of participants) {
    if (p.id !== myParticipantId) {
      grouped[p.status].push(p);
    }
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Participants</h3>
          <p style={styles.subtitle}>{participants.size}/12 in session</p>
        </div>
        <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        {/* Green Room */}
        {grouped['green-room'].length > 0 && (
          <Section
            title="Green Room"
            subtitle="Waiting to be admitted"
            color="#f59e0b"
            participants={grouped['green-room']}
            isHostOrCoHost={isHostOrCoHost}
            actions={(p) => (
              <>
                <ActionBtn label="Admit" color="var(--success)" onClick={() => onStageAction('move-to-stage', p.id)} />
                <ActionBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} />
              </>
            )}
          />
        )}

        {/* On Stage */}
        <Section
          title="On Stage"
          subtitle="Visible in the broadcast"
          color="var(--success)"
          participants={grouped['on-stage']}
          isHostOrCoHost={isHostOrCoHost}
          actions={(p) => (
            <>
              {!p.audioEnabled ? null : (
                <ActionBtn label="Mute" color="var(--text-muted)" onClick={() => onStageAction('mute', p.id)} />
              )}
              <ActionBtn label="Backstage" color="var(--warning)" onClick={() => onStageAction('move-to-backstage', p.id)} />
              {p.role === 'guest' && (
                <ActionBtn label="Co-host" color="var(--accent)" onClick={() => onStageAction('promote-co-host', p.id)} />
              )}
              {p.role === 'co-host' && (
                <ActionBtn label="Demote" color="var(--text-muted)" onClick={() => onStageAction('demote-to-guest', p.id)} />
              )}
            </>
          )}
        />

        {/* Backstage */}
        {grouped['backstage'].length > 0 && (
          <Section
            title="Backstage"
            subtitle="Can hear but not visible"
            color="var(--accent)"
            participants={grouped['backstage']}
            isHostOrCoHost={isHostOrCoHost}
            actions={(p) => (
              <>
                <ActionBtn label="To Stage" color="var(--success)" onClick={() => onStageAction('move-to-stage', p.id)} />
                <ActionBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} />
              </>
            )}
          />
        )}

        {/* Admit All button for green room */}
        {grouped['green-room'].length > 1 && isHostOrCoHost && (
          <button
            className="btn-primary"
            style={styles.admitAllBtn}
            onClick={() => grouped['green-room'].forEach((p) => onStageAction('move-to-stage', p.id))}
          >
            Admit All ({grouped['green-room'].length})
          </button>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  color,
  participants,
  isHostOrCoHost,
  actions,
}: {
  title: string;
  subtitle: string;
  color: string;
  participants: Participant[];
  isHostOrCoHost: boolean;
  actions: (p: Participant) => React.ReactNode;
}) {
  return (
    <div style={sectionStyles.section}>
      <div style={sectionStyles.sectionHeader}>
        <div style={{ ...sectionStyles.dot, background: color }} />
        <div>
          <span style={sectionStyles.sectionTitle}>{title}</span>
          <span style={sectionStyles.sectionCount}> ({participants.length})</span>
        </div>
      </div>
      <p style={sectionStyles.sectionSub}>{subtitle}</p>

      {participants.length === 0 ? (
        <p style={sectionStyles.empty}>No participants</p>
      ) : (
        <div style={sectionStyles.list}>
          {participants.map((p) => (
            <div key={p.id} className="participant-item" style={sectionStyles.item}>
              <div style={sectionStyles.itemLeft}>
                <div style={sectionStyles.avatar}>{p.name.charAt(0).toUpperCase()}</div>
                <div>
                  <span style={sectionStyles.name}>{p.name}</span>
                  <div style={sectionStyles.badges}>
                    {p.role !== 'guest' && (
                      <span style={{ ...sectionStyles.roleBadge, background: p.role === 'host' ? 'var(--accent-subtle)' : 'var(--success-subtle)', color: p.role === 'host' ? 'var(--accent)' : 'var(--success)' }}>
                        {p.role}
                      </span>
                    )}
                    {!p.audioEnabled && <span style={sectionStyles.muteBadge}>muted</span>}
                    {!p.videoEnabled && <span style={sectionStyles.muteBadge}>cam off</span>}
                  </div>
                </div>
              </div>
              {isHostOrCoHost && p.role !== 'host' && (
                <div style={sectionStyles.actions}>{actions(p)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      className="participant-action-btn"
      style={{ ...actionStyles.btn, color, borderColor: color + '33', '--btn-hover-bg': color + '1a' } as React.CSSProperties}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '14px 16px 10px',
    borderBottom: '1px solid var(--border)',
  },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  subtitle: { fontSize: 11, color: 'var(--text-muted)', margin: 0, marginTop: 2 },
  closeBtn: {
    background: 'none', border: 'none', color: 'var(--text-muted)',
    cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex',
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 0',
  },
  admitAllBtn: {
    margin: '8px 16px',
    width: 'calc(100% - 32px)',
    fontSize: 13,
    padding: '8px 14px',
  },
};

const sectionStyles: Record<string, React.CSSProperties> = {
  section: { padding: '8px 16px 12px' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 },
  dot: { width: 8, height: 8, borderRadius: '50%' },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },
  sectionCount: { fontSize: 12, color: 'var(--text-muted)' },
  sectionSub: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 },
  empty: { fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' },
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  item: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8, gap: 8,
  },
  itemLeft: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 },
  avatar: {
    width: 30, height: 30, borderRadius: '50%',
    background: 'var(--bg-surface)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
    flexShrink: 0,
  },
  name: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', display: 'block' },
  badges: { display: 'flex', gap: 4, marginTop: 2 },
  roleBadge: {
    fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4,
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  muteBadge: {
    fontSize: 9, fontWeight: 500, padding: '1px 5px', borderRadius: 4,
    background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
  },
  actions: { display: 'flex', gap: 3, flexShrink: 0 },
};

const actionStyles: Record<string, React.CSSProperties> = {
  btn: {
    fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 5,
    background: 'transparent', border: '1px solid',
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
    transition: 'all 150ms',
  },
};
