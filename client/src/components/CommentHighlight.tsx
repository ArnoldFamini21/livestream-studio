import { useState, useEffect, useRef } from 'react';
import type { ChatMessage, ExternalChatPlatform } from '@studio/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HighlightedComment {
  id: string;
  sourceMessageId?: string;
  senderName: string;
  content: string;
  avatarColor?: string;
  sourcePlatform?: ExternalChatPlatform;
  displayMode?: CommentDisplayMode;
  durationMs?: number;
}

export type CommentDisplayMode = 'featured' | 'flash';
export type CommentHighlightFilter = 'ready' | 'recent' | 'all';

export const FEATURED_COMMENT_DURATION_MS = 8000;
export const FLASH_COMMENT_DURATION_MS = 4200;

interface CommentHighlightOverlayProps {
  comment: HighlightedComment | null;
  onExpired?: () => void;
}

interface CommentHighlightManagerProps {
  chatMessages: ChatMessage[];
  activeComment: HighlightedComment | null;
  onHighlightComment: (comment: HighlightedComment) => void;
  onFlashComment: (comment: HighlightedComment) => void;
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

const COMMENT_FILTERS: Array<{ value: CommentHighlightFilter; label: string }> = [
  { value: 'ready', label: 'Ready' },
  { value: 'recent', label: 'Recent' },
  { value: 'all', label: 'All' },
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getCommentTimestamp(message: ChatMessage): number {
  const parsed = Date.parse(message.starredAt || message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCommentSearchText(message: ChatMessage): string {
  return [
    message.senderName,
    message.content,
    message.source?.platform || '',
    message.source?.externalId || '',
    message.pinned ? 'pinned' : '',
    message.starred ? 'starred ready' : '',
    new Date(message.timestamp).toLocaleString(),
  ].join(' ').toLowerCase();
}

interface CreateHighlightedCommentOptions {
  id?: string;
  displayMode?: CommentDisplayMode;
  durationMs?: number;
}

export function createHighlightedCommentFromChatMessage(
  message: ChatMessage,
  options: CreateHighlightedCommentOptions = {}
): HighlightedComment | null {
  if (message.isBackstage || message.recipientId) return null;
  return {
    id: options.id || message.id,
    sourceMessageId: message.id,
    senderName: message.senderName,
    content: message.content,
    sourcePlatform: message.source?.platform,
    displayMode: options.displayMode || 'featured',
    durationMs: options.durationMs || FEATURED_COMMENT_DURATION_MS,
  };
}

export function isHighlightedCommentSource(comment: HighlightedComment | null, messageId: string): boolean {
  return Boolean(comment && (comment.id === messageId || comment.sourceMessageId === messageId));
}

export function getCommentSourceLabel(platform: ExternalChatPlatform | undefined): string {
  if (platform === 'youtube') return 'YouTube';
  if (platform === 'facebook') return 'Facebook';
  return '';
}

export function getHighlightableChatMessages(
  chatMessages: ChatMessage[],
  query: string,
  filter: CommentHighlightFilter,
  limit = 30
): ChatMessage[] {
  const publicMessages = chatMessages.filter((message) => !message.isBackstage && !message.recipientId);
  const candidates = filter === 'ready'
    ? publicMessages.filter((message) => message.starred)
    : filter === 'recent'
      ? publicMessages.slice(-20)
      : publicMessages;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return candidates
    .filter((message) => {
      if (terms.length === 0) return true;
      const searchText = getCommentSearchText(message);
      return terms.every((term) => searchText.includes(term));
    })
    .sort((a, b) => getCommentTimestamp(b) - getCommentTimestamp(a))
    .slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------------------
// CommentHighlightOverlay — the on-screen display overlay
// ---------------------------------------------------------------------------

export function CommentHighlightOverlay({ comment, onExpired }: CommentHighlightOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<HighlightedComment | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onExpiredRef = useRef(onExpired);

  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);

  useEffect(() => {
    // Clear any existing timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);

    if (comment) {
      setCurrent(comment);
      // Small delay to ensure the DOM has the element before animating in
      requestAnimationFrame(() => setVisible(true));

      const durationMs = Math.min(
        15000,
        Math.max(1200, comment.durationMs || FEATURED_COMMENT_DURATION_MS)
      );

      timerRef.current = setTimeout(() => {
        setVisible(false);
        onExpiredRef.current?.();
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
  const isFlash = current.displayMode === 'flash';
  const sourceLabel = getCommentSourceLabel(current.sourcePlatform);

  return (
    <div
      aria-live="polite"
      style={{
        ...overlayContainer,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0) scale(1)' : 'translateY(18px) scale(0.98)',
      }}
    >
      {/* Inject keyframes */}
      <style>{overlayKeyframes}</style>

      <div
        style={{
          ...overlayCard,
          ...(isFlash ? overlayCardFlash : {}),
          animation: visible
            ? `${isFlash ? 'commentFlashIn 420ms cubic-bezier(0.16, 1, 0.3, 1)' : 'commentPopIn 560ms cubic-bezier(0.16, 1, 0.3, 1)'} both, ${isFlash ? 'commentFlashGlow 1.4s ease-in-out 260ms 2' : 'commentGlow 3s ease-in-out 700ms infinite'}`
            : 'commentPopOut 260ms ease-in both',
        }}
      >
        <div
          style={{
            ...overlayAccent,
            ...(isFlash ? overlayAccentFlash : {}),
            animation: visible ? 'commentAccentSweep 1100ms ease-out 120ms both' : undefined,
          }}
        />

        <div style={overlayMetaRow}>
          <span style={{ ...overlayPill, ...(isFlash ? overlayPillFlash : {}) }}>
            {isFlash ? 'Audience flash' : 'Featured comment'}
          </span>
          {sourceLabel && (
            <span style={{
              ...overlaySourcePill,
              ...(current.sourcePlatform === 'facebook' ? overlaySourcePillFacebook : {}),
            }}>
              {sourceLabel}
            </span>
          )}
        </div>

        <div style={overlayBody}>
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
  onFlashComment,
  onDismissComment,
}: CommentHighlightManagerProps) {
  const [customName, setCustomName] = useState('');
  const [customContent, setCustomContent] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CommentHighlightFilter>('ready');
  const listRef = useRef<HTMLDivElement>(null);

  const handleShowCustom = () => {
    if (!customName.trim() || !customContent.trim()) return;
    onHighlightComment({
      id: `custom-${Date.now()}`,
      senderName: customName.trim(),
      content: customContent.trim(),
      displayMode: 'featured',
      durationMs: FEATURED_COMMENT_DURATION_MS,
    });
    setCustomName('');
    setCustomContent('');
  };

  const handleFlashCustom = () => {
    if (!customName.trim() || !customContent.trim()) return;
    onFlashComment({
      id: `custom-flash-${Date.now()}`,
      senderName: customName.trim(),
      content: customContent.trim(),
      displayMode: 'flash',
      durationMs: FLASH_COMMENT_DURATION_MS,
    });
    setCustomName('');
    setCustomContent('');
  };

  const handleHighlightChat = (msg: ChatMessage) => {
    const comment = createHighlightedCommentFromChatMessage(msg);
    if (comment) onHighlightComment(comment);
  };

  const handleFlashChat = (msg: ChatMessage) => {
    const comment = createHighlightedCommentFromChatMessage(msg, {
      id: `flash-${msg.id}-${Date.now()}`,
      displayMode: 'flash',
      durationMs: FLASH_COMMENT_DURATION_MS,
    });
    if (comment) onFlashComment(comment);
  };

  const visibleMessages = getHighlightableChatMessages(chatMessages, query, filter);

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
        <div style={styles.customActionRow}>
          <button
            className="btn-secondary"
            style={styles.showBtn}
            onClick={handleFlashCustom}
            disabled={!customName.trim() || !customContent.trim()}
          >
            Flash
          </button>
          <button
            className="btn-primary"
            style={styles.showBtn}
            onClick={handleShowCustom}
            disabled={!customName.trim() || !customContent.trim()}
          >
            Show on Screen
          </button>
        </div>
      </div>

      {/* Divider */}
      <div style={styles.divider} />

      {/* From Chat section */}
      <div style={styles.chatSection}>
        <div style={styles.chatSectionHeader}>
          <span style={styles.fieldLabel}>Comments</span>
          <span style={styles.chatCount}>{visibleMessages.length}</span>
        </div>
        <input
          aria-label="Search comments to highlight"
          style={styles.searchInput}
          placeholder="Search comments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={120}
        />
        <div style={styles.filterRow} role="group" aria-label="Comment highlight filter">
          {COMMENT_FILTERS.map((item) => {
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                style={{
                  ...styles.filterBtn,
                  ...(active ? styles.filterBtnActive : {}),
                }}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <div ref={listRef} style={styles.chatList}>
          {visibleMessages.length === 0 && (
            <div style={styles.emptyChat}>
              <span style={styles.emptyChatText}>
                {query.trim() ? 'No matching comments' : filter === 'ready' ? 'No starred comments yet' : 'No chat messages yet'}
              </span>
            </div>
          )}
          {visibleMessages.map((msg) => (
            <div key={msg.id} className="participant-item" style={styles.chatRow}>
              <div style={styles.chatRowInfo}>
                <span style={styles.chatRowName}>
                  {msg.senderName}
                  {msg.source?.platform && (
                    <span style={{
                      ...styles.chatSourceBadge,
                      ...(msg.source.platform === 'facebook' ? styles.chatSourceBadgeFacebook : {}),
                    }}>
                      {getCommentSourceLabel(msg.source.platform)}
                    </span>
                  )}
                  {msg.pinned && <span style={styles.chatPinBadge}>Pinned</span>}
                  {msg.starred && <span style={styles.chatStarBadge}>Starred</span>}
                </span>
                <span style={styles.chatRowText}>{msg.content}</span>
              </div>
              <div style={styles.chatRowActions}>
                <button
                  className="participant-action-btn"
                  style={styles.flashBtn}
                  onClick={() => handleFlashChat(msg)}
                  title="Flash this comment briefly"
                >
                  Flash
                </button>
                <button
                  className="participant-action-btn"
                  style={styles.highlightBtn}
                  onClick={() => handleHighlightChat(msg)}
                  title="Show this comment on screen"
                >
                  Show
                </button>
              </div>
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
@keyframes commentPopIn {
  0% { opacity: 0; transform: translateY(34px) scale(0.94); filter: blur(6px); }
  55% { opacity: 1; transform: translateY(-4px) scale(1.01); filter: blur(0); }
  100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}

@keyframes commentPopOut {
  0% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
  100% { opacity: 0; transform: translateY(18px) scale(0.97); filter: blur(4px); }
}

@keyframes commentFlashIn {
  0% { opacity: 0; transform: translateY(26px) scale(0.92); filter: blur(8px) brightness(1.3); }
  46% { opacity: 1; transform: translateY(-7px) scale(1.03); filter: blur(0) brightness(1.12); }
  100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0) brightness(1); }
}

@keyframes commentAccentSweep {
  0% { transform: translateX(-102%); opacity: 0; }
  22% { opacity: 1; }
  100% { transform: translateX(0); opacity: 1; }
}

@keyframes commentGlow {
  0%, 100% { box-shadow: 0 18px 42px rgba(0,0,0,0.34), 0 0 0 1px rgba(255,255,255,0.16), 0 0 28px rgba(34,211,238,0.12); }
  50% { box-shadow: 0 20px 48px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,255,255,0.2), 0 0 34px rgba(167,139,250,0.16); }
}

@keyframes commentFlashGlow {
  0%, 100% { box-shadow: 0 18px 42px rgba(0,0,0,0.36), 0 0 0 1px rgba(255,255,255,0.18), 0 0 24px rgba(251,191,36,0.14); }
  50% { box-shadow: 0 24px 56px rgba(0,0,0,0.46), 0 0 0 1px rgba(251,191,36,0.38), 0 0 44px rgba(244,114,182,0.22); }
}

@media (prefers-reduced-motion: reduce) {
  @keyframes commentPopIn {
    from { opacity: 0; transform: translateY(8px); filter: none; }
    to { opacity: 1; transform: translateY(0); filter: none; }
  }

  @keyframes commentPopOut {
    from { opacity: 1; transform: translateY(0); filter: none; }
    to { opacity: 0; transform: translateY(8px); filter: none; }
  }

  @keyframes commentFlashIn {
    from { opacity: 0; transform: translateY(8px); filter: none; }
    to { opacity: 1; transform: translateY(0); filter: none; }
  }

  @keyframes commentAccentSweep {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(0); opacity: 1; }
  }

  @keyframes commentGlow {
    from { box-shadow: 0 18px 42px rgba(0,0,0,0.34), 0 0 0 1px rgba(255,255,255,0.16); }
    to { box-shadow: 0 18px 42px rgba(0,0,0,0.34), 0 0 0 1px rgba(255,255,255,0.16); }
  }

  @keyframes commentFlashGlow {
    from { box-shadow: 0 18px 42px rgba(0,0,0,0.34), 0 0 0 1px rgba(255,255,255,0.16); }
    to { box-shadow: 0 18px 42px rgba(0,0,0,0.34), 0 0 0 1px rgba(255,255,255,0.16); }
  }
}
`;

// ---------------------------------------------------------------------------
// Overlay styles (top-level consts for the on-screen display)
// ---------------------------------------------------------------------------

const overlayContainer: React.CSSProperties = {
  position: 'absolute',
  bottom: 96,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'center',
  zIndex: 11,
  pointerEvents: 'none',
  padding: '0 24px',
  transition: 'opacity 0.32s cubic-bezier(0.16, 1, 0.3, 1), transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)',
};

const overlayCard: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '13px 18px 16px',
  background: 'linear-gradient(135deg, rgba(14, 18, 30, 0.9), rgba(17, 24, 39, 0.8))',
  backdropFilter: 'blur(18px) saturate(130%)',
  WebkitBackdropFilter: 'blur(18px) saturate(130%)',
  borderRadius: 8,
  border: '1px solid rgba(255, 255, 255, 0.18)',
  boxShadow: '0 18px 42px rgba(0, 0, 0, 0.34), 0 0 0 1px rgba(255, 255, 255, 0.16)',
  maxWidth: 560,
  width: 'min(92vw, 560px)',
  minHeight: 96,
  overflow: 'hidden',
  transformOrigin: 'bottom center',
};

const overlayCardFlash: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(24, 21, 16, 0.92), rgba(30, 16, 34, 0.82))',
  border: '1px solid rgba(251, 191, 36, 0.3)',
};

const overlayAccent: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 4,
  background: 'linear-gradient(90deg, #22d3ee 0%, #a78bfa 48%, #f472b6 100%)',
};

const overlayAccentFlash: React.CSSProperties = {
  height: 5,
  background: 'linear-gradient(90deg, #facc15 0%, #fb7185 52%, #a78bfa 100%)',
};

const overlayMetaRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  minHeight: 18,
};

const overlayPill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  alignSelf: 'flex-start',
  minHeight: 18,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'rgba(34, 211, 238, 0.16)',
  border: '1px solid rgba(125, 211, 252, 0.28)',
  color: '#cffafe',
  fontSize: 10,
  fontWeight: 800,
  lineHeight: 1,
  letterSpacing: 0,
  textTransform: 'uppercase',
};

const overlayPillFlash: React.CSSProperties = {
  background: 'rgba(251, 191, 36, 0.17)',
  border: '1px solid rgba(251, 191, 36, 0.34)',
  color: '#fef3c7',
};

const overlaySourcePill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  alignSelf: 'flex-start',
  minHeight: 18,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'rgba(239, 68, 68, 0.14)',
  border: '1px solid rgba(248, 113, 113, 0.26)',
  color: '#fecaca',
  fontSize: 10,
  fontWeight: 800,
  lineHeight: 1,
  letterSpacing: 0,
  textTransform: 'uppercase',
};

const overlaySourcePillFacebook: React.CSSProperties = {
  background: 'rgba(59, 130, 246, 0.15)',
  border: '1px solid rgba(96, 165, 250, 0.28)',
  color: '#dbeafe',
};

const overlayBody: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  minWidth: 0,
};

const overlayAvatar: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.22)',
};

const overlayAvatarLetter: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: 'white',
  lineHeight: 1,
  textTransform: 'uppercase',
};

const overlayTextWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
  flex: 1,
};

const overlaySenderName: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: 'rgba(255, 255, 255, 0.95)',
  lineHeight: 1.1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const overlayContent: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  fontSize: 18,
  fontWeight: 700,
  color: 'rgba(255, 255, 255, 0.92)',
  lineHeight: 1.25,
  margin: 0,
  wordWrap: 'break-word',
  overflowWrap: 'break-word',
  overflow: 'hidden',
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
  customActionRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(72px, 0.7fr) minmax(0, 1.3fr)',
    gap: 6,
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
  chatSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chatCount: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontWeight: 700,
    paddingRight: 4,
  },
  searchInput: {
    width: '100%',
    height: 32,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    padding: '0 9px',
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box',
  },
  filterRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 4,
  },
  filterBtn: {
    height: 27,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 800,
    cursor: 'pointer',
  },
  filterBtnActive: {
    background: 'rgba(245, 158, 11, 0.14)',
    borderColor: 'rgba(245, 158, 11, 0.35)',
    color: '#fbbf24',
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
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  chatStarBadge: {
    fontSize: 8,
    fontWeight: 800,
    padding: '1px 4px',
    borderRadius: 4,
    background: 'rgba(245, 158, 11, 0.14)',
    color: '#fbbf24',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  chatSourceBadge: {
    fontSize: 8,
    fontWeight: 800,
    padding: '1px 4px',
    borderRadius: 4,
    background: 'rgba(239, 68, 68, 0.14)',
    color: '#fca5a5',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  chatSourceBadgeFacebook: {
    background: 'rgba(59, 130, 246, 0.14)',
    color: '#bfdbfe',
  },
  chatPinBadge: {
    fontSize: 8,
    fontWeight: 800,
    padding: '1px 4px',
    borderRadius: 4,
    background: 'rgba(34, 211, 238, 0.12)',
    color: '#67e8f9',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  chatRowText: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chatRowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
  },
  flashBtn: {
    height: 28,
    minWidth: 50,
    borderRadius: 6,
    background: 'rgba(251, 191, 36, 0.12)',
    border: '1px solid rgba(251, 191, 36, 0.32)',
    color: '#fbbf24',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 800,
    padding: '0 8px',
    flexShrink: 0,
    transition: 'all 0.15s ease',
  },
  highlightBtn: {
    minWidth: 46,
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 8px',
    fontSize: 10,
    fontWeight: 800,
    flexShrink: 0,
    transition: 'all 0.15s ease',
  },
};
