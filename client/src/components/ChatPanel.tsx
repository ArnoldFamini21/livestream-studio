import { useState, useRef, useEffect } from 'react';
import type { ChatMessage } from '@studio/shared';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  onClose: () => void;
  senderName: string;
}

const MAX_MESSAGE_LENGTH = 2000;
const CHAR_COUNT_THRESHOLD = 1800;

export function ChatPanel({ messages, onSend, onClose, senderName }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 100;
  };

  useEffect(() => {
    if (isNearBottomRef.current || messages.length === 1) { // Also auto-scroll on first message
      // Delay slightly to ensure React has fully committed the new message elements to the DOM
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }, [messages.length]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH) return;
    onSend(text);
    setInput('');
  };

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <h3 style={styles.title}>Chat</h3>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} style={styles.messages} onScroll={handleScroll} role="log" aria-live="polite" aria-label="Chat messages">
        {messages.length === 0 && (
          <div style={styles.empty}>
            <p style={styles.emptyText}>No messages yet</p>
            <p style={styles.emptyHint}>Start the conversation!</p>
          </div>
        )}
        {messages.map((msg) => {
          const isMe = msg.senderName === senderName;
          return (
            <div
              key={msg.id}
              style={{
                ...styles.message,
                animation: 'slideUp 0.2s ease-out',
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
              </div>
              <p style={styles.msgContent}>{msg.content}</p>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={styles.inputArea}>
        {input.length >= CHAR_COUNT_THRESHOLD && (
          <div style={{
            ...styles.charCount,
            color: input.length > MAX_MESSAGE_LENGTH ? '#ef4444' : 'var(--text-muted)',
          }}>
            {input.length}/{MAX_MESSAGE_LENGTH}
          </div>
        )}
        <div style={styles.inputBar}>
          <input
            style={styles.input}
            placeholder="Type a message..."
            value={input}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <button
            style={{
              ...styles.sendBtn,
              opacity: input.trim() && input.trim().length <= MAX_MESSAGE_LENGTH ? 1 : 0.4,
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
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
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
    gap: 2,
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
  msgContent: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
    wordBreak: 'break-word',
    margin: 0,
  },
  inputArea: {
    borderTop: '1px solid var(--border)',
  },
  charCount: {
    fontSize: 11,
    textAlign: 'right' as const,
    padding: '4px 12px 0',
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
