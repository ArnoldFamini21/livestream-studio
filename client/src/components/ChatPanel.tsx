import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { CHAT_REACTION_EMOJIS, CHAT_REACTION_LABELS, CHAT_REACTION_TYPES } from '@studio/shared';
import { formatChatTypingNames } from '../utils/chatTyping.ts';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (content: string, recipientId?: string) => void;
  onReact?: (messageId: string, reaction: ChatReactionType) => void;
  onTypingChange?: (typing: boolean, recipientId?: string) => void;
  onClose: () => void;
  senderName: string;
  directRecipients?: Array<{ id: string; name: string; role?: string }>;
  typingUsers?: string[];
  title?: string;
  placeholder?: string;
  emptyText?: string;
  emptyHint?: string;
}

const MAX_MESSAGE_LENGTH = 2000;
const CHAR_COUNT_THRESHOLD = 1800;
const TYPING_IDLE_MS = 2_500;

export function ChatPanel({
  messages,
  onSend,
  onReact,
  onTypingChange,
  onClose,
  senderName,
  directRecipients = [],
  typingUsers = [],
  title = 'Chat',
  placeholder = 'Type a message...',
  emptyText = 'No messages yet',
  emptyHint = 'Start the conversation!',
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const typingStateRef = useRef<{ typing: boolean; recipientId?: string }>({ typing: false });
  const typingTimerRef = useRef<number | null>(null);
  const onTypingChangeRef = useRef(onTypingChange);
  const selectedRecipient = directRecipients.find((recipient) => recipient.id === recipientId);
  const typingLabel = formatChatTypingNames(typingUsers);
  const pinnedMessage = messages.reduce<ChatMessage | null>((latest, message) => {
    if (!message.pinned || message.isBackstage || message.recipientId) return latest;
    if (!latest) return message;
    const messageTime = Date.parse(message.pinnedAt || message.timestamp);
    const latestTime = Date.parse(latest.pinnedAt || latest.timestamp);
    return messageTime >= latestTime ? message : latest;
  }, null);

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 100;
  };

  const clearTypingTimer = useCallback(() => {
    if (typingTimerRef.current === null) return;
    window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
  }, []);

  const emitTyping = useCallback((typing: boolean, nextRecipientId?: string) => {
    const typingChangeHandler = onTypingChangeRef.current;
    if (!typingChangeHandler) return;
    const normalizedRecipientId = nextRecipientId || undefined;
    const current = typingStateRef.current;
    if (current.typing === typing && current.recipientId === normalizedRecipientId) return;
    typingStateRef.current = { typing, recipientId: normalizedRecipientId };
    typingChangeHandler(typing, normalizedRecipientId);
  }, []);

  const scheduleTypingStop = useCallback((nextRecipientId?: string) => {
    clearTypingTimer();
    typingTimerRef.current = window.setTimeout(() => {
      emitTyping(false, nextRecipientId);
      typingTimerRef.current = null;
    }, TYPING_IDLE_MS);
  }, [clearTypingTimer, emitTyping]);

  const stopTyping = useCallback(() => {
    clearTypingTimer();
    const current = typingStateRef.current;
    if (current.typing) emitTyping(false, current.recipientId);
  }, [clearTypingTimer, emitTyping]);

  useEffect(() => {
    if (isNearBottomRef.current || messages.length === 1) { // Also auto-scroll on first message
      // Delay slightly to ensure React has fully committed the new message elements to the DOM
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }, [messages.length]);

  useEffect(() => {
    onTypingChangeRef.current = onTypingChange;
  }, [onTypingChange]);

  useEffect(() => stopTyping, [stopTyping]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH) return;
    stopTyping();
    onSend(text, selectedRecipient?.id);
    setInput('');
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    const nextRecipientId = selectedRecipient?.id;
    if (!value.trim()) {
      stopTyping();
      return;
    }
    emitTyping(true, nextRecipientId);
    scheduleTypingStop(nextRecipientId);
  };

  const handleRecipientChange = (nextRecipientId: string) => {
    const wasTyping = typingStateRef.current.typing;
    stopTyping();
    setRecipientId(nextRecipientId);
    if (!input.trim()) return;
    if (wasTyping) {
      const normalizedRecipientId = nextRecipientId || undefined;
      emitTyping(true, normalizedRecipientId);
      scheduleTypingStop(normalizedRecipientId);
    }
  };

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <h3 style={styles.title}>{title}</h3>
        <button
          className="chat-close-btn"
          style={styles.closeBtn}
          onClick={onClose}
          aria-label="Close chat"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} style={styles.messages} onScroll={handleScroll} role="log" aria-live="polite" aria-label="Chat messages">
        {pinnedMessage && (
          <div style={styles.pinnedBanner}>
            <span style={styles.pinnedLabel}>Pinned</span>
            <span style={styles.pinnedText}>{pinnedMessage.content}</span>
          </div>
        )}
        {messages.length === 0 && (
          <div style={styles.empty}>
            <p style={styles.emptyText}>{emptyText}</p>
            <p style={styles.emptyHint}>{emptyHint}</p>
          </div>
        )}
        {messages.map((msg) => {
          const isMe = msg.senderName === senderName;
          return (
            <div
              key={msg.id}
              className="chat-msg-enter"
              style={{
                ...styles.message,
                ...(msg.starred ? styles.messageStarred : {}),
                ...(msg.pinned ? styles.messagePinned : {}),
              }}
            >
              <div style={styles.msgHeader}>
                <span style={{
                  ...styles.msgName,
                  color: isMe ? 'var(--accent-hover)' : 'var(--text-primary)',
                }}>
                  {msg.senderName}
                </span>
                <span style={styles.msgTime}>
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {msg.recipientId && <span style={styles.privateBadge}>Private</span>}
                {msg.recipientId && <span style={styles.privateMeta}>to {msg.recipientName || 'participant'}</span>}
                {msg.pinned && <span style={styles.pinBadge}>Pinned</span>}
                {msg.starred && <span style={styles.starBadge}>Starred</span>}
              </div>
              <p style={styles.msgContent}>{msg.content}</p>
              {onReact && (
                <div style={styles.reactionRow}>
                  {CHAT_REACTION_TYPES.map((reaction) => (
                    <button
                      key={reaction}
                      type="button"
                      style={styles.reactionBtn}
                      onClick={() => onReact(msg.id, reaction)}
                      title={`${CHAT_REACTION_LABELS[reaction]} reaction`}
                      aria-label={`${CHAT_REACTION_LABELS[reaction]} reaction${msg.reactions?.[reaction] ? `, ${msg.reactions[reaction]} total` : ''}`}
                    >
                      <span aria-hidden="true" style={styles.reactionEmoji}>{CHAT_REACTION_EMOJIS[reaction]}</span>
                      {msg.reactions?.[reaction] ? <span style={styles.reactionCount}>{msg.reactions[reaction]}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={styles.inputArea}>
        {directRecipients.length > 0 && (
          <select
            style={styles.recipientSelect}
            value={recipientId}
            onChange={(event) => handleRecipientChange(event.target.value)}
            aria-label="Chat recipient"
          >
            <option value="">Everyone</option>
            {directRecipients.map((recipient) => (
              <option key={recipient.id} value={recipient.id}>
                {recipient.name}{recipient.role ? ` (${recipient.role})` : ''}
              </option>
            ))}
          </select>
        )}
        <div style={styles.typingIndicator} aria-live="polite">
          {typingLabel}
        </div>
        {input.length >= CHAR_COUNT_THRESHOLD && (
          <div style={{
            ...styles.charCount,
            color: input.length > MAX_MESSAGE_LENGTH ? 'var(--danger)' : 'var(--text-muted)',
          }}>
            {input.length}/{MAX_MESSAGE_LENGTH}
          </div>
        )}
        <div style={styles.inputBar}>
          <input
            style={styles.input}
            placeholder={selectedRecipient ? `Message ${selectedRecipient.name} privately...` : placeholder}
            value={input}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <button
            className="chat-send-btn"
            style={{
              ...styles.sendBtn,
              opacity: input.trim() && input.trim().length <= MAX_MESSAGE_LENGTH ? 1 : 0.4,
              pointerEvents: input.trim() && input.trim().length <= MAX_MESSAGE_LENGTH ? 'auto' : 'none',
            }}
            onClick={handleSend}
            disabled={!input.trim() || input.trim().length > MAX_MESSAGE_LENGTH}
            aria-label="Send message"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 300,
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(15, 23, 42, 0.6)',
    borderLeft: '1px solid rgba(255, 255, 255, 0.06)',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
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
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  pinnedBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 10px',
    borderRadius: 8,
    border: '1px solid rgba(167, 139, 250, 0.28)',
    background: 'rgba(167, 139, 250, 0.08)',
  },
  pinnedLabel: {
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 800,
    color: 'var(--accent)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  pinnedText: {
    minWidth: 0,
    flex: 1,
    fontSize: 12,
    lineHeight: 1.35,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  emptyText: {
    fontSize: 13,
    color: 'var(--text-muted)',
    fontWeight: 500,
  },
  emptyHint: {
    fontSize: 12,
    color: 'var(--text-muted)',
    opacity: 0.6,
  },
  message: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    padding: 8,
    borderRadius: 8,
    border: '1px solid transparent',
  },
  messageStarred: {
    borderColor: 'rgba(245, 158, 11, 0.28)',
    background: 'rgba(245, 158, 11, 0.06)',
  },
  messagePinned: {
    borderColor: 'rgba(167, 139, 250, 0.28)',
    background: 'rgba(167, 139, 250, 0.055)',
  },
  msgHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  msgName: {
    fontSize: 12,
    fontWeight: 600,
  },
  msgTime: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  starBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'rgba(245, 158, 11, 0.14)',
    color: '#fbbf24',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  privateBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'rgba(34, 197, 94, 0.13)',
    color: '#86efac',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  privateMeta: {
    fontSize: 10,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  pinBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'rgba(167, 139, 250, 0.12)',
    color: 'var(--accent)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  msgContent: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
    wordBreak: 'break-word',
    margin: 0,
  },
  reactionRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 5,
  },
  reactionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: 32,
    minHeight: 24,
    border: '1px solid var(--border)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-secondary)',
    borderRadius: 6,
    padding: '0 7px',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
  },
  reactionEmoji: {
    fontSize: 14,
    lineHeight: 1,
  },
  reactionCount: {
    minWidth: 14,
    height: 14,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px',
    borderRadius: 999,
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'var(--text-primary)',
    fontSize: 9,
    lineHeight: 1,
  },
  inputArea: {
    borderTop: '1px solid var(--border)',
  },
  recipientSelect: {
    width: 'calc(100% - 24px)',
    margin: '10px 12px 0',
    minHeight: 34,
    padding: '7px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: 12,
    outline: 'none',
  },
  charCount: {
    fontSize: 11,
    textAlign: 'right' as const,
    padding: '4px 12px 0',
  },
  typingIndicator: {
    minHeight: 18,
    padding: '6px 12px 0',
    color: 'var(--accent)',
    fontSize: 11,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  inputBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
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
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    background: 'var(--accent-solid)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'opacity var(--transition-fast)',
  },
};
