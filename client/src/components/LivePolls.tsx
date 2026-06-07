import { useMemo, useState } from 'react';
import type { LivePoll } from '@studio/shared';

interface LivePollsPanelProps {
  polls: LivePoll[];
  canManagePolls: boolean;
  canVotePolls: boolean;
  myVotes: Record<string, string>;
  onCreatePoll: (question: string, options: string[]) => void;
  onVote: (pollId: string, optionId: string) => void;
  onClosePoll: (pollId: string) => void;
  onHighlightPoll: (pollId: string) => void;
  onUnhighlightPoll: (pollId: string) => void;
  onClose: () => void;
}

interface LivePollOverlayProps {
  poll: LivePoll | null;
}

const EMPTY_OPTIONS = ['', ''];

export function LivePollsPanel({
  polls,
  canManagePolls,
  canVotePolls,
  myVotes,
  onCreatePoll,
  onVote,
  onClosePoll,
  onHighlightPoll,
  onUnhighlightPoll,
  onClose,
}: LivePollsPanelProps) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(EMPTY_OPTIONS);

  const sortedPolls = useMemo(
    () => [...polls].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [polls],
  );

  const canCreate = question.trim().length > 0 && options.filter((option) => option.trim()).length >= 2;

  const handleCreate = () => {
    if (!canCreate) return;
    onCreatePoll(question, options);
    setQuestion('');
    setOptions(EMPTY_OPTIONS);
  };

  const updateOption = (index: number, value: string) => {
    setOptions((current) => current.map((option, optionIndex) => optionIndex === index ? value : option));
  };

  const addOption = () => {
    setOptions((current) => current.length >= 6 ? current : [...current, '']);
  };

  const removeOption = (index: number) => {
    setOptions((current) => current.length <= 2 ? current : current.filter((_, optionIndex) => optionIndex !== index));
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Polls</h3>
          <p style={styles.subtitle}>{polls.length} poll{polls.length === 1 ? '' : 's'}</p>
        </div>
        <button type="button" className="panel-close-btn" style={styles.closeBtn} onClick={onClose} aria-label="Close polls">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {canManagePolls && (
        <div style={styles.createCard}>
          <label style={styles.label}>Question</label>
          <input
            style={styles.input}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should we cover next?"
            maxLength={240}
          />
          <div style={styles.optionList}>
            {options.map((option, index) => (
              <div key={index} style={styles.optionEditRow}>
                <input
                  style={styles.input}
                  value={option}
                  onChange={(event) => updateOption(index, event.target.value)}
                  placeholder={`Option ${index + 1}`}
                  maxLength={80}
                />
                <button
                  type="button"
                  style={styles.optionRemoveBtn}
                  onClick={() => removeOption(index)}
                  disabled={options.length <= 2}
                  aria-label={`Remove option ${index + 1}`}
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <div style={styles.createActions}>
            <button type="button" style={styles.secondaryBtn} onClick={addOption} disabled={options.length >= 6}>Add Option</button>
            <button type="button" className="btn-primary" style={styles.createBtn} onClick={handleCreate} disabled={!canCreate}>Start Poll</button>
          </div>
        </div>
      )}

      <div style={styles.pollList}>
        {sortedPolls.length === 0 && (
          <div style={styles.emptyCard}>
            <p style={styles.emptyTitle}>No polls yet</p>
            <p style={styles.emptyText}>{canManagePolls ? 'Create a poll to collect audience input.' : 'Polls from the host will appear here.'}</p>
          </div>
        )}

        {sortedPolls.map((poll) => (
          <PollCard
            key={poll.id}
            poll={poll}
            canManagePolls={canManagePolls}
            canVotePolls={canVotePolls}
            selectedOptionId={myVotes[poll.id]}
            onVote={onVote}
            onClosePoll={onClosePoll}
            onHighlightPoll={onHighlightPoll}
            onUnhighlightPoll={onUnhighlightPoll}
          />
        ))}
      </div>
    </div>
  );
}

function PollCard({
  poll,
  canManagePolls,
  canVotePolls,
  selectedOptionId,
  onVote,
  onClosePoll,
  onHighlightPoll,
  onUnhighlightPoll,
}: {
  poll: LivePoll;
  canManagePolls: boolean;
  canVotePolls: boolean;
  selectedOptionId?: string;
  onVote: (pollId: string, optionId: string) => void;
  onClosePoll: (pollId: string) => void;
  onHighlightPoll: (pollId: string) => void;
  onUnhighlightPoll: (pollId: string) => void;
}) {
  const isClosed = poll.status === 'closed';

  return (
    <div className="participant-item" style={{ ...styles.pollCard, ...(poll.highlighted ? styles.pollCardHighlighted : {}) }}>
      <div style={styles.pollTop}>
        <div style={styles.pollMeta}>
          <span style={styles.pollStatus}>{isClosed ? 'Closed' : 'Open'}</span>
          <span style={styles.pollVotes}>{poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}</span>
        </div>
        {canManagePolls && (
          <div style={styles.hostActions}>
            <button type="button" style={styles.iconBtn} onClick={() => poll.highlighted ? onUnhighlightPoll(poll.id) : onHighlightPoll(poll.id)} title={poll.highlighted ? 'Hide on stream' : 'Show on stream'}>
              {poll.highlighted ? 'Hide' : 'Show'}
            </button>
            {!isClosed && <button type="button" style={styles.iconBtn} onClick={() => onClosePoll(poll.id)}>Close</button>}
          </div>
        )}
      </div>
      <h4 style={styles.pollQuestion}>{poll.question}</h4>
      <div style={styles.pollOptions}>
        {poll.options.map((option) => {
          const percent = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
          const selected = selectedOptionId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              style={{
                ...styles.voteOption,
                ...(selected ? styles.voteOptionSelected : {}),
                cursor: isClosed || !canVotePolls ? 'default' : 'pointer',
              }}
              onClick={() => {
                if (!isClosed && canVotePolls) onVote(poll.id, option.id);
              }}
              disabled={isClosed || !canVotePolls}
            >
              <span style={{ ...styles.voteFill, width: `${percent}%` }} />
              <span style={styles.voteText}>{option.text}</span>
              <span style={styles.votePercent}>{percent}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LivePollOverlay({ poll }: LivePollOverlayProps) {
  if (!poll) return null;

  return (
    <div style={overlayStyles.container}>
      <div style={overlayStyles.card}>
        <div style={overlayStyles.header}>
          <span style={overlayStyles.badge}>{poll.status === 'open' ? 'Live Poll' : 'Poll Results'}</span>
          <span style={overlayStyles.votes}>{poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}</span>
        </div>
        <h3 style={overlayStyles.question}>{poll.question}</h3>
        <div style={overlayStyles.options}>
          {poll.options.map((option) => {
            const percent = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
            return (
              <div key={option.id} style={overlayStyles.option}>
                <span style={{ ...overlayStyles.optionFill, width: `${percent}%` }} />
                <span style={overlayStyles.optionText}>{option.text}</span>
                <span style={overlayStyles.optionPercent}>{percent}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    right: 16,
    bottom: 86,
    width: 360,
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'min(620px, calc(100vh - 120px))',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    boxShadow: '0 24px 72px rgba(0, 0, 0, 0.45)',
    overflow: 'hidden',
    zIndex: 1200,
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  title: { margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' },
  subtitle: { margin: '2px 0 0', fontSize: 11, color: 'var(--text-muted)' },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex' },
  createCard: { margin: 12, padding: 12, borderRadius: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  input: { width: '100%', minWidth: 0, height: 34, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12, outline: 'none' },
  optionList: { display: 'flex', flexDirection: 'column', gap: 6 },
  optionEditRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 28px', gap: 6 },
  optionRemoveBtn: { borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, cursor: 'pointer' },
  createActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  secondaryBtn: { height: 32, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 800, cursor: 'pointer' },
  createBtn: { height: 32, padding: '0 12px', fontSize: 11, fontWeight: 800 },
  pollList: { flex: 1, overflowY: 'auto', padding: 12, paddingTop: 0, display: 'flex', flexDirection: 'column', gap: 10 },
  emptyCard: { padding: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)' },
  emptyTitle: { margin: 0, fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' },
  emptyText: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.4, color: 'var(--text-muted)' },
  pollCard: { padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column', gap: 9 },
  pollCardHighlighted: { borderColor: 'rgba(245, 158, 11, 0.42)', boxShadow: '0 0 0 1px rgba(245, 158, 11, 0.16) inset' },
  pollTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pollMeta: { display: 'flex', alignItems: 'center', gap: 6 },
  pollStatus: { fontSize: 10, fontWeight: 800, color: '#67e8f9', textTransform: 'uppercase', letterSpacing: '0.04em' },
  pollVotes: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 },
  hostActions: { display: 'flex', gap: 5 },
  iconBtn: { height: 24, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', fontSize: 10, fontWeight: 800, cursor: 'pointer' },
  pollQuestion: { margin: 0, fontSize: 13, lineHeight: 1.35, color: 'var(--text-primary)' },
  pollOptions: { display: 'flex', flexDirection: 'column', gap: 6 },
  voteOption: { position: 'relative', minHeight: 34, overflow: 'hidden', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', textAlign: 'left', padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.035)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700 },
  voteOptionSelected: { borderColor: 'rgba(103, 232, 249, 0.42)', color: 'var(--text-primary)' },
  voteFill: { position: 'absolute', inset: '0 auto 0 0', background: 'rgba(103, 232, 249, 0.12)', pointerEvents: 'none' },
  voteText: { position: 'relative', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  votePercent: { position: 'relative', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontSize: 11 },
};

const overlayStyles: Record<string, React.CSSProperties> = {
  container: { position: 'absolute', left: 32, bottom: 32, zIndex: 34, pointerEvents: 'none' },
  card: { width: 430, maxWidth: 'calc(100vw - 64px)', padding: 18, borderRadius: 12, background: 'rgba(15, 23, 42, 0.92)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 16px 48px rgba(0,0,0,0.35)' },
  header: { display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
  badge: { fontSize: 11, fontWeight: 900, color: '#67e8f9', textTransform: 'uppercase', letterSpacing: '0.08em' },
  votes: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' },
  question: { margin: '0 0 12px', fontSize: 18, lineHeight: 1.25, color: 'white' },
  options: { display: 'flex', flexDirection: 'column', gap: 8 },
  option: { position: 'relative', minHeight: 34, overflow: 'hidden', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', padding: '0 10px', borderRadius: 7, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.08)' },
  optionFill: { position: 'absolute', inset: '0 auto 0 0', background: 'rgba(103, 232, 249, 0.25)', pointerEvents: 'none' },
  optionText: { position: 'relative', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'white', fontSize: 13, fontWeight: 800 },
  optionPercent: { position: 'relative', color: '#cffafe', fontSize: 12, fontWeight: 900, fontVariantNumeric: 'tabular-nums' },
};
