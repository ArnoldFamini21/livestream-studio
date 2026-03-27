import { useState, useMemo } from 'react';

export interface QAQuestion {
  id: string;
  authorName: string;
  content: string;
  timestamp: string;
  upvotes: number;
  status: 'pending' | 'approved' | 'answered' | 'dismissed';
  answer?: string;
  highlighted: boolean;
}

// ---------------------------------------------------------------------------
// WebinarQAPanel — host's Q&A management view
// ---------------------------------------------------------------------------

interface WebinarQAPanelProps {
  questions: QAQuestion[];
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onHighlight: (id: string) => void;
  onUnhighlight: (id: string) => void;
  onClose: () => void;
}

type FilterTab = 'all' | 'pending' | 'approved' | 'answered';

export function WebinarQAPanel({
  questions,
  onApprove,
  onDismiss,
  onAnswer,
  onHighlight,
  onUnhighlight,
  onClose,
}: WebinarQAPanelProps) {
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState('');

  const filteredQuestions = useMemo(() => {
    const filtered =
      activeTab === 'all'
        ? questions.filter((q) => q.status !== 'dismissed')
        : questions.filter((q) => q.status === activeTab);

    return filtered.sort((a, b) => b.upvotes - a.upvotes);
  }, [questions, activeTab]);

  const pendingCount = useMemo(
    () => questions.filter((q) => q.status === 'pending').length,
    [questions],
  );

  const totalCount = useMemo(
    () => questions.filter((q) => q.status !== 'dismissed').length,
    [questions],
  );

  const handleSubmitAnswer = (id: string) => {
    const text = answerDraft.trim();
    if (!text) return;
    onAnswer(id, text);
    setAnsweringId(null);
    setAnswerDraft('');
  };

  const handleCancelAnswer = () => {
    setAnsweringId(null);
    setAnswerDraft('');
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'answered', label: 'Answered' },
  ];

  const emptyMessages: Record<FilterTab, string> = {
    all: 'No questions yet',
    pending: 'No pending questions',
    approved: 'No approved questions',
    answered: 'No answered questions',
  };

  return (
    <div style={panelStyles.panel}>
      {/* Header */}
      <div style={panelStyles.header}>
        <div style={panelStyles.headerLeft}>
          <h3 style={panelStyles.title}>Q&A</h3>
          <span style={panelStyles.badge}>
            {totalCount}
          </span>
          {pendingCount > 0 && (
            <span style={panelStyles.pendingBadge}>
              {pendingCount} new
            </span>
          )}
        </div>
        <button className="panel-close-btn" style={panelStyles.closeBtn} onClick={onClose} aria-label="Close Q&A panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Filter tabs */}
      <div style={panelStyles.tabs}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            style={{
              ...panelStyles.tab,
              ...(activeTab === tab.key ? panelStyles.tabActive : {}),
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Question list */}
      <div style={panelStyles.questionList} aria-live="polite" aria-label="Questions">
        {filteredQuestions.length === 0 && (
          <div style={panelStyles.empty}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)', opacity: 0.4 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p style={panelStyles.emptyText}>{emptyMessages[activeTab]}</p>
          </div>
        )}

        {filteredQuestions.map((q) => (
          <div
            key={q.id}
            className="participant-item"
            style={{
              ...panelStyles.questionCard,
              ...(q.highlighted ? panelStyles.questionCardHighlighted : {}),
            }}
          >
            {/* Question header */}
            <div style={panelStyles.questionHeader}>
              <div style={panelStyles.questionMeta}>
                <span style={panelStyles.authorName}>{q.authorName}</span>
                <span style={panelStyles.timestamp}>
                  {new Date(q.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={panelStyles.upvoteBadge}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 4l-8 8h5v8h6v-8h5z" />
                </svg>
                <span>{q.upvotes}</span>
              </div>
            </div>

            {/* Question text */}
            <p style={panelStyles.questionText}>{q.content}</p>

            {/* Answer display (for answered questions) */}
            {q.status === 'answered' && q.answer && (
              <div style={panelStyles.answerDisplay}>
                <span style={panelStyles.answerLabel}>A:</span>
                <p style={panelStyles.answerText}>{q.answer}</p>
              </div>
            )}

            {/* Inline answer input */}
            {answeringId === q.id && (
              <div style={panelStyles.answerInputArea}>
                <textarea
                  style={panelStyles.answerTextarea}
                  placeholder="Type your answer..."
                  value={answerDraft}
                  onChange={(e) => setAnswerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmitAnswer(q.id);
                    }
                    if (e.key === 'Escape') handleCancelAnswer();
                  }}
                  autoFocus
                  rows={2}
                />
                <div style={panelStyles.answerActions}>
                  <button
                    style={panelStyles.answerCancelBtn}
                    onClick={handleCancelAnswer}
                  >
                    Cancel
                  </button>
                  <button
                    style={{
                      ...panelStyles.answerSubmitBtn,
                      opacity: answerDraft.trim() ? 1 : 0.4,
                    }}
                    onClick={() => handleSubmitAnswer(q.id)}
                    disabled={!answerDraft.trim()}
                  >
                    Submit
                  </button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div style={panelStyles.actionRow}>
              {/* Pending: Approve + Dismiss */}
              {q.status === 'pending' && (
                <>
                  <button
                    className="participant-action-btn"
                    style={panelStyles.actionBtn}
                    onClick={() => onApprove(q.id)}
                    title="Approve"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                  <button
                    className="participant-action-btn"
                    style={panelStyles.actionBtn}
                    onClick={() => onDismiss(q.id)}
                    title="Dismiss"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </>
              )}

              {/* Approved: Answer + Highlight + Dismiss */}
              {q.status === 'approved' && (
                <>
                  <button
                    className="participant-action-btn"
                    style={panelStyles.actionBtn}
                    onClick={() => {
                      setAnsweringId(q.id);
                      setAnswerDraft('');
                    }}
                    title="Answer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 17 4 12 9 7" />
                      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                    </svg>
                  </button>
                  <button
                    style={{
                      ...panelStyles.actionBtn,
                      ...(q.highlighted ? panelStyles.highlightActive : {}),
                    }}
                    onClick={() => q.highlighted ? onUnhighlight(q.id) : onHighlight(q.id)}
                    title={q.highlighted ? 'Remove highlight' : 'Highlight on screen'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill={q.highlighted ? 'var(--warning, #f59e0b)' : 'none'} stroke={q.highlighted ? 'var(--warning, #f59e0b)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </button>
                  <button
                    className="participant-action-btn"
                    style={panelStyles.actionBtn}
                    onClick={() => onDismiss(q.id)}
                    title="Dismiss"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </>
              )}

              {/* Answered: Highlight toggle */}
              {q.status === 'answered' && (
                <button
                  style={{
                    ...panelStyles.actionBtn,
                    ...(q.highlighted ? panelStyles.highlightActive : {}),
                  }}
                  onClick={() => q.highlighted ? onUnhighlight(q.id) : onHighlight(q.id)}
                  title={q.highlighted ? 'Remove highlight' : 'Highlight on screen'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={q.highlighted ? 'var(--warning, #f59e0b)' : 'none'} stroke={q.highlighted ? 'var(--warning, #f59e0b)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebinarQAOverlay — on-screen Q&A display for highlighted questions
// ---------------------------------------------------------------------------

interface WebinarQAOverlayProps {
  question: QAQuestion | null;
}

export function WebinarQAOverlay({ question }: WebinarQAOverlayProps) {
  if (!question) return null;

  return (
    <div style={overlayStyles.container}>
      <style>{overlayKeyframes}</style>
      <div style={overlayStyles.card}>
        <div style={overlayStyles.questionRow}>
          <span style={overlayStyles.qLabel}>Q:</span>
          <span style={overlayStyles.qText}>{question.content}</span>
        </div>
        <span style={overlayStyles.author}>— {question.authorName}</span>
        {question.status === 'answered' && question.answer && (
          <div style={overlayStyles.answerRow}>
            <span style={overlayStyles.aLabel}>A:</span>
            <span style={overlayStyles.aText}>{question.answer}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebinarQAAudience — audience submission widget
// ---------------------------------------------------------------------------

interface WebinarQAAudienceProps {
  questions: QAQuestion[];
  onSubmitQuestion: (content: string) => void;
  onUpvote: (id: string) => void;
  myUpvotes: Set<string>;
}

export function WebinarQAAudience({
  questions,
  onSubmitQuestion,
  onUpvote,
  myUpvotes,
}: WebinarQAAudienceProps) {
  const [input, setInput] = useState('');

  const sortedQuestions = useMemo(
    () => [...questions].sort((a, b) => b.upvotes - a.upvotes),
    [questions],
  );

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onSubmitQuestion(text);
    setInput('');
  };

  return (
    <div style={audienceStyles.panel}>
      {/* Submit input */}
      <div style={audienceStyles.inputArea}>
        <input
          style={audienceStyles.input}
          placeholder="Ask a question..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
        />
        <button
          style={{
            ...audienceStyles.submitBtn,
            opacity: input.trim() ? 1 : 0.4,
          }}
          onClick={handleSubmit}
          disabled={!input.trim()}
          aria-label="Submit question"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Question list */}
      <div style={audienceStyles.questionList}>
        {sortedQuestions.length === 0 && (
          <div style={audienceStyles.empty}>
            <p style={audienceStyles.emptyText}>No questions yet</p>
            <p style={audienceStyles.emptyHint}>Be the first to ask!</p>
          </div>
        )}

        {sortedQuestions.map((q) => {
          const hasUpvoted = myUpvotes.has(q.id);
          return (
            <div key={q.id} className="participant-item" style={audienceStyles.questionCard}>
              {/* Upvote button */}
              <button
                style={{
                  ...audienceStyles.upvoteBtn,
                  ...(hasUpvoted ? audienceStyles.upvoteBtnActive : {}),
                }}
                onClick={() => onUpvote(q.id)}
                aria-label={`Upvote question by ${q.authorName}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill={hasUpvoted ? 'var(--accent)' : 'none'} stroke={hasUpvoted ? 'var(--accent)' : 'currentColor'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                <span style={{
                  ...audienceStyles.upvoteCount,
                  color: hasUpvoted ? 'var(--accent)' : 'var(--text-muted)',
                }}>
                  {q.upvotes}
                </span>
              </button>

              {/* Question content */}
              <div style={audienceStyles.questionBody}>
                <div style={audienceStyles.questionMeta}>
                  <span style={audienceStyles.authorName}>{q.authorName}</span>
                  <span style={audienceStyles.timestamp}>
                    {new Date(q.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p style={audienceStyles.questionText}>{q.content}</p>
                {q.status === 'answered' && q.answer && (
                  <div style={audienceStyles.answerBlock}>
                    <span style={audienceStyles.answerLabel}>Answer</span>
                    <p style={audienceStyles.answerText}>{q.answer}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlay keyframes
// ---------------------------------------------------------------------------

const overlayKeyframes = `
@keyframes qaSlideIn {
  from {
    opacity: 0;
    transform: translateX(-24px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
`;

// ---------------------------------------------------------------------------
// Overlay styles
// ---------------------------------------------------------------------------

const overlayStyles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 72,
    left: 24,
    zIndex: 10,
    maxWidth: 450,
    pointerEvents: 'none',
    animation: 'qaSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  card: {
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(16px)',
    borderRadius: 12,
    padding: '14px 18px',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  questionRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  qLabel: {
    fontSize: 14,
    fontWeight: 800,
    color: 'var(--accent, #6366f1)',
    flexShrink: 0,
    lineHeight: 1.4,
  },
  qText: {
    fontSize: 14,
    fontWeight: 500,
    color: 'white',
    lineHeight: 1.4,
  },
  author: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.55)',
    fontStyle: 'italic',
    paddingLeft: 22,
  },
  answerRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 4,
    paddingTop: 8,
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
  },
  aLabel: {
    fontSize: 14,
    fontWeight: 800,
    color: 'var(--success, #22c55e)',
    flexShrink: 0,
    lineHeight: 1.4,
  },
  aText: {
    fontSize: 14,
    fontWeight: 500,
    color: 'rgba(255, 255, 255, 0.9)',
    lineHeight: 1.4,
  },
};

// ---------------------------------------------------------------------------
// Host panel styles
// ---------------------------------------------------------------------------

const panelStyles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    color: 'var(--text-primary)',
  },
  badge: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    background: 'var(--bg-tertiary)',
    padding: '1px 7px',
    borderRadius: 10,
    lineHeight: '16px',
  },
  pendingBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--warning, #f59e0b)',
    background: 'rgba(245, 158, 11, 0.12)',
    padding: '1px 7px',
    borderRadius: 10,
    lineHeight: '16px',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    display: 'flex',
    gap: 0,
    padding: '0 12px',
    borderBottom: '1px solid var(--border)',
  },
  tab: {
    flex: 1,
    fontSize: 11,
    fontWeight: 500,
    padding: '8px 0',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'all 0.15s ease',
  },
  tabActive: {
    color: 'var(--accent)',
    borderBottomColor: 'var(--accent)',
    fontWeight: 600,
  },
  questionList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 13,
    color: 'var(--text-muted)',
    fontWeight: 500,
    margin: 0,
  },
  questionCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 12px',
    background: 'var(--bg-tertiary)',
    borderRadius: 8,
    borderLeft: '3px solid transparent',
  },
  questionCardHighlighted: {
    borderLeftColor: 'var(--warning, #f59e0b)',
    background: 'rgba(245, 158, 11, 0.06)',
  },
  questionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  questionMeta: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
  },
  authorName: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  timestamp: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  upvoteBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
  },
  questionText: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
    margin: 0,
    wordBreak: 'break-word',
  },
  answerDisplay: {
    display: 'flex',
    gap: 6,
    alignItems: 'flex-start',
    padding: '8px 10px',
    background: 'var(--bg-surface)',
    borderRadius: 6,
    marginTop: 2,
  },
  answerLabel: {
    fontSize: 11,
    fontWeight: 800,
    color: 'var(--success)',
    flexShrink: 0,
    lineHeight: 1.5,
  },
  answerText: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    margin: 0,
    wordBreak: 'break-word',
  },
  answerInputArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 2,
  },
  answerTextarea: {
    width: '100%',
    padding: '7px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.4,
    minHeight: 48,
    boxSizing: 'border-box',
  },
  answerActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 6,
  },
  answerCancelBtn: {
    fontSize: 11,
    fontWeight: 500,
    padding: '4px 10px',
    borderRadius: 6,
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  answerSubmitBtn: {
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 12px',
    borderRadius: 6,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    transition: 'opacity 0.15s ease',
  },
  actionRow: {
    display: 'flex',
    gap: 4,
    marginTop: 2,
  },
  actionBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'all 0.15s ease',
  },
  highlightActive: {
    background: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'var(--warning, #f59e0b)',
  },
};

// ---------------------------------------------------------------------------
// Audience panel styles
// ---------------------------------------------------------------------------

const audienceStyles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
  },
  inputArea: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 12px',
    borderBottom: '1px solid var(--border)',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 13,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
  },
  submitBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
    transition: 'opacity 0.15s ease',
  },
  questionList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 13,
    color: 'var(--text-muted)',
    fontWeight: 500,
    margin: 0,
  },
  emptyHint: {
    fontSize: 12,
    color: 'var(--text-muted)',
    opacity: 0.6,
    margin: 0,
  },
  questionCard: {
    display: 'flex',
    gap: 8,
    padding: '10px 12px',
    background: 'var(--bg-tertiary)',
    borderRadius: 8,
  },
  upvoteBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '4px 6px',
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.15s ease',
  },
  upvoteBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
  },
  upvoteCount: {
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
  },
  questionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
    flex: 1,
  },
  questionMeta: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
  },
  authorName: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  timestamp: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  questionText: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
    margin: 0,
    wordBreak: 'break-word',
  },
  answerBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '6px 8px',
    background: 'var(--bg-surface)',
    borderRadius: 6,
    marginTop: 4,
  },
  answerLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--success)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  answerText: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
    margin: 0,
    wordBreak: 'break-word',
  },
};
