import { useState, useEffect, useRef } from 'react';
import type { ChatMessage } from '@studio/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HighlightedComment {
  id: string;
  senderName: string;
  content: string;
  avatarColor?: string;
}

interface CommentHighlightOverlayProps {
  comment: HighlightedComment | null;
}

interface CommentHighlightManagerProps {
  chatMessages: ChatMessage[];
  activeComment: HighlightedComment | null;
  onHighlightComment: (comment: HighlightedComment) => void;
  onDismissComment: () => void;
}

// ---------------------------------------------------------------------------
// Avatar color palette — deterministic color from sender name
// ---------------------------------------------------------------------------

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#2563eb',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// CommentHighlightOverlay — the on-screen display overlay
// ---------------------------------------------------------------------------

export function CommentHighlightOverlay({ comment }: CommentHighlightOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<HighlightedComment | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear any existing timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);

    if (comment) {
      setCurrent(comment);
      // Small delay to ensure the DOM has the element before animating in
      requestAnimationFrame(() => setVisible(true));

      // Auto-dismiss after 8 seconds
      timerRef.current = setTimeout(() => {
        setVisible(false);
        // Wait for exit animation before removing from DOM
        dismissTimerRef.current = setTimeout(() => {
          setCurrent(null);
        }, 400);
      }, 8000);
    } else {
      // Animate out
      setVisible(false);
      dismissTimerRef.current = setTimeout(() => {
        setCurrent(null);
      }, 400);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [comment]);

  if (!current) return null;

  const color = current.avatarColor || getAvatarColor(current.senderName);
  const initial = current.senderName.charAt(0).toUpperCase();

  return (
    <div
      style={{
        ...overlayContainer,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(16px)',
      }}
    >
      {/* Inject keyframes */}
      <style>{overlayKeyframes}</style>

      <div style={overlayCard}>
        {/* Avatar */}
        <div
          style={{
            ...overlayAvatar,
            background: color,
          }}
        >
          <span style={overlayAvatarLetter}>{initial}</span>
        </div>

        {/* Text content */}
        <div style={overlayTextWrap}>
          <span style={overlaySenderName}>{current.senderName}</span>
          <p style={overlayContent}>{current.content}</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentHighlightManager — the sidebar/panel control
// ---------------------------------------------------------------------------

export function CommentHighlightManager({
  chatMessages,
  activeComment,
  onHighlightComment,
  onDismissComment,
}: CommentHighlightManagerProps) {
  const [customName, setCustomName] = useState('');
  const [customContent, setCustomContent] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const handleShowCustom = () => {
    if (!customName.trim() || !customContent.trim()) return;
    onHighlightComment({
      id: `custom-${Date.now()}`,
      senderName: customName.trim(),
      content: customContent.trim(),
    });
    setCustomName('');
    setCustomContent('');
  };

  const handleHighlightChat = (msg: ChatMessage) => {
    onHighlightComment({
      id: msg.id,
      senderName: msg.senderName,
      content: msg.content,
    });
  };

  const recentMessages = chatMessages.slice(-20);

  return (
    <div style={styles.container}>
      <h4 style={styles.sectionTitle}>Comment Highlight</h4>

      {/* Currently showing indicator */}
      {activeComment && (
        <div style={styles.activeIndicator}>
          <div style={styles.activeHeader}>
            <div style={styles.activeDot} />
            <span style={styles.activeLabel}>Currently Showing</span>
          </div>
          <div style={styles.activePreview}>
            <span style={styles.activePreviewName}>{activeComment.senderName}</span>
            <span style={styles.activePreviewText}>{activeComment.content}</span>
          </div>
          <button style={styles.dismissBtn} onClick={onDismissComment}>
            Dismiss
          </button>
        </div>
      )}

      {/* Custom Comment section */}
      <div style={styles.form}>
        <span style={styles.fieldLabel}>Custom Comment</span>
        <input
          style={styles.input}
          placeholder="Sender name"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
        />
        <textarea
          style={styles.textarea}
          placeholder="Comment text..."
          value={customContent}
          onChange={(e) => setCustomContent(e.target.value)}
          rows={2}
        />
        <button
          className="btn-primary"
          style={styles.showBtn}
          onClick={handleShowCustom}
          disabled={!customName.trim() || !customContent.trim()}
        >
          Show on Screen
        </button>
      </div>

      {/* Divider */}
      <div style={styles.divider} />

      {/* From Chat section */}
      <div style={styles.chatSection}>
        <span style={styles.fieldLabel}>From Chat</span>
        <div ref={listRef} style={styles.chatList}>
          {recentMessages.length === 0 && (
            <div style={styles.emptyChat}>
              <span style={styles.emptyChatText}>No chat messages yet</span>
            </div>
          )}
          {recentMessages.map((msg) => (
            <div key={msg.id} style={styles.chatRow}>
              <div style={styles.chatRowInfo}>
                <span style={styles.chatRowName}>{msg.senderName}</span>
                <span style={styles.chatRowText}>{msg.content}</span>
              </div>
              <button
                style={styles.highlightBtn}
                onClick={() => handleHighlightChat(msg)}
                title="Highlight this comment"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlay keyframes
// ---------------------------------------------------------------------------

const overlayKeyframes = `
@keyframes commentGlow {
  0%, 100% { box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.08); }
  50% { box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.12); }
}
`;

// ---------------------------------------------------------------------------
// Overlay styles (top-level consts for the on-screen display)
// ---------------------------------------------------------------------------

const overlayContainer: React.CSSProperties = {
  position: 'absolute',
  bottom: 100,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'center',
  zIndex: 11,
  pointerEvents: 'none',
  transition: 'opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
};

const overlayCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '14px 18px',
  background: 'rgba(15, 15, 20, 0.7)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderRadius: 14,
  border: '1px solid rgba(255, 255, 255, 0.1)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08)',
  animation: 'commentGlow 3s ease-in-out infinite',
  maxWidth: 500,
  width: '90%',
};

const overlayAvatar: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const overlayAvatarLetter: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: 'white',
  lineHeight: 1,
  textTransform: 'uppercase',
};

const overlayTextWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
  flex: 1,
};

const overlaySenderName: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'rgba(255, 255, 255, 0.95)',
  lineHeight: 1,
};

const overlayContent: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: 'rgba(255, 255, 255, 0.8)',
  lineHeight: 1.45,
  margin: 0,
  wordWrap: 'break-word',
  overflowWrap: 'break-word',
};

// ---------------------------------------------------------------------------
// Manager panel styles
// ---------------------------------------------------------------------------

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

  // Active comment indicator
  activeIndicator: {
    margin: '0 12px 12px',
    padding: '10px 12px',
    background: 'var(--accent-subtle)',
    border: '1px solid var(--accent)',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  activeHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--success)',
    flexShrink: 0,
  },
  activeLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--accent-hover)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  activePreview: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    paddingLeft: 12,
  },
  activePreviewName: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  activePreviewText: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dismissBtn: {
    alignSelf: 'flex-start',
    marginLeft: 12,
    fontSize: 10,
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: 4,
    background: 'var(--danger)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    letterSpacing: '0.02em',
  },

  // Custom comment form
  form: {
    padding: '0 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '0 4px',
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
  textarea: {
    width: '100%',
    padding: '7px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.4,
  },
  showBtn: {
    fontSize: 12,
    padding: '7px 12px',
  },

  // Divider
  divider: {
    height: 1,
    background: 'var(--border)',
    margin: '12px 16px',
  },

  // Chat messages section
  chatSection: {
    padding: '0 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  chatList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    maxHeight: 280,
    overflowY: 'auto',
  },
  emptyChat: {
    padding: '16px 0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyChatText: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  chatRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 8px',
    background: 'var(--bg-tertiary)',
    borderRadius: 6,
    gap: 8,
  },
  chatRowInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    minWidth: 0,
    flex: 1,
  },
  chatRowName: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  chatRowText: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  highlightBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
    transition: 'all 0.15s ease',
  },
};
