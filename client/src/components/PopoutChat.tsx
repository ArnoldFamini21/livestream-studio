import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { CHAT_REACTION_EMOJIS, CHAT_REACTION_LABELS, CHAT_REACTION_TYPES } from '@studio/shared';
import {
  getPopoutChatChannelName,
  readPopoutChatSession,
  type PopoutChatCommand,
  type PopoutChatState,
} from '../utils/popoutChat.ts';

type ChatMode = 'public' | 'starred' | 'backstage' | 'direct';
type ConnectionStatus = 'waiting' | 'connected' | 'unavailable';

const MAX_MESSAGE_LENGTH = 2000;

export function PopoutChat() {
  const { roomId = '' } = useParams<{ roomId: string }>();
  const location = useLocation();
  const sessionId = useMemo(() => readPopoutChatSession(location.search), [location.search]);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PopoutChatState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('waiting');
  const [mode, setMode] = useState<ChatMode>('public');
  const [input, setInput] = useState('');
  const supportsBroadcastChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window;

  const messages = state?.messages || [];
  const publicMessages = messages.filter((message) => !message.isBackstage && !message.recipientId);
  const starredMessages = publicMessages.filter((message) => message.starred);
  const pinnedMessage = publicMessages.reduce<ChatMessage | null>((latest, message) => {
    if (!message.pinned) return latest;
    if (!latest) return message;
    const messageTime = Date.parse(message.pinnedAt || message.timestamp);
    const latestTime = Date.parse(latest.pinnedAt || latest.timestamp);
    return messageTime >= latestTime ? message : latest;
  }, null);
  const backstageMessages = messages.filter((message) => message.isBackstage);
  const directMessages = messages.filter((message) => Boolean(message.recipientId));
  const visibleMessages = mode === 'backstage'
    ? backstageMessages
    : mode === 'direct'
      ? directMessages
      : mode === 'starred'
        ? starredMessages
        : publicMessages;

  const postCommand = useCallback((command: PopoutChatCommand) => {
    channelRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    if (!supportsBroadcastChannel || !roomId || !sessionId) {
      setStatus('unavailable');
      return;
    }

    const channel = new BroadcastChannel(getPopoutChatChannelName(roomId, sessionId));
    channelRef.current = channel;
    setStatus('waiting');

    const timeout = window.setTimeout(() => {
      setStatus((current) => (current === 'connected' ? current : 'unavailable'));
    }, 4_000);

    channel.onmessage = (event) => {
      const message = event.data as Partial<PopoutChatState>;
      if (message?.type !== 'state' || message.roomId !== roomId || !Array.isArray(message.messages)) return;
      window.clearTimeout(timeout);
      setState(message as PopoutChatState);
      setStatus('connected');
    };

    channel.postMessage({ type: 'ready' } satisfies PopoutChatCommand);
    channel.postMessage({ type: 'request-state' } satisfies PopoutChatCommand);

    return () => {
      window.clearTimeout(timeout);
      if (channelRef.current === channel) channelRef.current = null;
      channel.close();
    };
  }, [roomId, sessionId, supportsBroadcastChannel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages.length, mode]);

  const handleSend = () => {
    const content = input.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) return;
    if (mode === 'direct') return;
    postCommand({
      type: 'send-message',
      payload: {
        content,
        isBackstage: mode === 'backstage',
      },
    });
    setInput('');
  };

  const handleReact = (messageId: string, reaction: ChatReactionType) => {
    postCommand({ type: 'react', payload: { messageId, reaction } });
  };

  const handleToggleStar = (messageId: string, starred: boolean) => {
    postCommand({ type: 'toggle-star', payload: { messageId, starred } });
  };

  const handleTogglePin = (messageId: string, pinned: boolean) => {
    postCommand({ type: 'toggle-pin', payload: { messageId, pinned } });
  };

  const statusLabel = status === 'connected'
    ? state?.connected ? 'Synced' : 'Studio offline'
    : status === 'waiting'
      ? 'Connecting'
      : 'Disconnected';

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <div style={styles.titleBlock}>
          <span style={styles.eyebrow}>Studio Chat</span>
          <h1 style={styles.title}>{state?.roomName || 'Pop-out Chat'}</h1>
        </div>
        <div style={styles.headerActions}>
          <span style={{
            ...styles.statusBadge,
            ...(status === 'connected' ? styles.statusGood : styles.statusBad),
          }}>
            {statusLabel}
          </span>
          <button type="button" style={styles.iconButton} onClick={() => window.close()} title="Close window" aria-label="Close window">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      <div style={styles.tabs} role="tablist" aria-label="Chat mode">
        <ModeButton label="Public" count={publicMessages.length} active={mode === 'public'} onClick={() => setMode('public')} />
        <ModeButton label="Starred" count={starredMessages.length} active={mode === 'starred'} onClick={() => setMode('starred')} />
        <ModeButton label="Direct" count={directMessages.length} active={mode === 'direct'} onClick={() => setMode('direct')} />
        <ModeButton label="Backstage" count={backstageMessages.length} active={mode === 'backstage'} onClick={() => setMode('backstage')} />
      </div>

      <section style={styles.messages} aria-live="polite" aria-label="Chat messages">
        {pinnedMessage && (mode === 'public' || mode === 'starred') && (
          <div style={styles.pinnedBanner}>
            <span style={styles.pinnedLabel}>Pinned</span>
            <span style={styles.pinnedText}>{pinnedMessage.content}</span>
          </div>
        )}
        {visibleMessages.length === 0 && (
          <div style={styles.empty}>
            <p style={styles.emptyTitle}>
              {status === 'connected'
                ? mode === 'starred'
                  ? 'No starred comments'
                  : mode === 'direct'
                    ? 'No direct messages'
                  : mode === 'backstage'
                    ? 'No backstage notes'
                    : 'No public messages'
                : 'No active chat connection'}
            </p>
            <p style={styles.emptyDetail}>
              {status === 'connected'
                ? mode === 'starred'
                  ? 'Star comments from Public to keep them ready.'
                  : mode === 'direct'
                    ? 'Private messages from the studio appear here.'
                  : mode === 'backstage'
                    ? 'Backstage notes stay with producers.'
                    : 'Incoming public chat appears here.'
                : 'Open pop-out chat from an active studio.'}
            </p>
          </div>
        )}

        {visibleMessages.map((message) => (
          <ChatMessageCard
            key={message.id}
            message={message}
            isMine={message.senderName === state?.senderName}
            onReact={handleReact}
            onToggleStar={handleToggleStar}
            onTogglePin={handleTogglePin}
          />
        ))}
        <div ref={bottomRef} />
      </section>

      <footer style={styles.composer}>
        <input
          style={styles.input}
          value={input}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSend();
          }}
          placeholder={mode === 'direct' ? 'Use the studio window to send private messages...' : mode === 'backstage' ? 'Backstage note...' : 'Public message...'}
          disabled={status !== 'connected' || mode === 'direct'}
        />
        <button
          type="button"
          className="chat-send-btn"
          style={{ ...styles.sendButton, opacity: input.trim() && status === 'connected' && mode !== 'direct' ? 1 : 0.45 }}
          onClick={handleSend}
          disabled={!input.trim() || status !== 'connected' || mode === 'direct'}
          aria-label="Send message"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </footer>
    </main>
  );
}

function ModeButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      style={{ ...styles.tabButton, ...(active ? styles.tabButtonActive : {}) }}
      onClick={onClick}
    >
      <span>{label}</span>
      <span style={styles.tabCount}>{count}</span>
    </button>
  );
}

function ChatMessageCard({
  message,
  isMine,
  onReact,
  onToggleStar,
  onTogglePin,
}: {
  message: ChatMessage;
  isMine: boolean;
  onReact: (messageId: string, reaction: ChatReactionType) => void;
  onToggleStar: (messageId: string, starred: boolean) => void;
  onTogglePin: (messageId: string, pinned: boolean) => void;
}) {
  return (
    <article style={{ ...styles.messageCard, ...(message.starred ? styles.messageCardStarred : {}), ...(message.pinned ? styles.messageCardPinned : {}) }}>
      <div style={styles.messageHeader}>
        <span style={{ ...styles.messageSender, color: isMine ? 'var(--accent-hover)' : 'var(--text-primary)' }}>
          {message.senderName}
        </span>
        {message.isBackstage && <span style={styles.backstageBadge}>Backstage</span>}
        {message.recipientId && <span style={styles.privateBadge}>Private</span>}
        {message.recipientId && <span style={styles.privateMeta}>to {message.recipientName || 'participant'}</span>}
        {message.pinned && <span style={styles.pinBadge}>Pinned</span>}
        {message.starred && <span style={styles.starBadge}>Starred</span>}
        <time style={styles.messageTime}>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
      <p style={styles.messageContent}>{message.content}</p>
      <div style={styles.actions}>
        {!message.isBackstage && !message.recipientId && (
          <>
            <button
              type="button"
              style={{ ...styles.actionButton, ...(message.pinned ? styles.actionButtonPinned : {}) }}
              onClick={() => onTogglePin(message.id, !message.pinned)}
            >
              {message.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              style={{ ...styles.actionButton, ...(message.starred ? styles.actionButtonActive : {}) }}
              onClick={() => onToggleStar(message.id, !message.starred)}
            >
              {message.starred ? 'Unstar' : 'Star'}
            </button>
          </>
        )}
        {CHAT_REACTION_TYPES.map((reaction) => (
          <button
            key={reaction}
            type="button"
            style={{ ...styles.actionButton, ...styles.reactionButton }}
            onClick={() => onReact(message.id, reaction)}
            title={`${CHAT_REACTION_LABELS[reaction]} reaction`}
            aria-label={`${CHAT_REACTION_LABELS[reaction]} reaction${message.reactions?.[reaction] ? `, ${message.reactions[reaction]} total` : ''}`}
          >
            <span aria-hidden="true" style={styles.reactionEmoji}>{CHAT_REACTION_EMOJIS[reaction]}</span>
            {message.reactions?.[reaction] ? <span style={styles.reactionCount}>{message.reactions[reaction]}</span> : null}
          </button>
        ))}
      </div>
    </article>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    height: '100vh',
    display: 'grid',
    gridTemplateRows: 'auto auto 1fr auto',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    overflow: 'hidden',
  },
  header: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 16px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'rgba(15, 23, 42, 0.92)',
  },
  titleBlock: { minWidth: 0 },
  eyebrow: { display: 'block', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--text-muted)', marginBottom: 3 },
  title: { margin: 0, fontSize: 18, fontWeight: 800, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headerActions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  statusBadge: { fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, border: '1px solid', borderRadius: 999, padding: '4px 8px' },
  statusGood: { color: '#86efac', borderColor: 'rgba(34, 197, 94, 0.25)', background: 'rgba(34, 197, 94, 0.1)' },
  statusBad: { color: '#fcd34d', borderColor: 'rgba(245, 158, 11, 0.25)', background: 'rgba(245, 158, 11, 0.1)' },
  iconButton: { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  tabs: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, padding: 10, background: 'rgba(15, 23, 42, 0.76)', borderBottom: '1px solid var(--border)' },
  tabButton: { minWidth: 0, minHeight: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: 11, fontWeight: 800, cursor: 'pointer' },
  tabButtonActive: { borderColor: 'rgba(167, 139, 250, 0.55)', background: 'rgba(167, 139, 250, 0.13)', color: '#ddd6fe' },
  tabCount: { minWidth: 18, height: 18, borderRadius: 999, background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 },
  messages: { minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  pinnedBanner: { border: '1px solid rgba(34, 211, 238, 0.26)', borderRadius: 8, background: 'rgba(34, 211, 238, 0.08)', padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 8 },
  pinnedLabel: { flexShrink: 0, fontSize: 9, fontWeight: 900, color: '#67e8f9', textTransform: 'uppercase', letterSpacing: 0 },
  pinnedText: { minWidth: 0, flex: 1, fontSize: 12, lineHeight: 1.35, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, textAlign: 'center', padding: 24 },
  emptyTitle: { margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--text-secondary)' },
  emptyDetail: { margin: 0, maxWidth: 300, fontSize: 12, lineHeight: 1.4, color: 'var(--text-muted)' },
  messageCard: { border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, background: 'rgba(255,255,255,0.035)', padding: 10, display: 'flex', flexDirection: 'column', gap: 7 },
  messageCardStarred: { borderColor: 'rgba(245, 158, 11, 0.3)', background: 'rgba(245, 158, 11, 0.07)' },
  messageCardPinned: { borderColor: 'rgba(34, 211, 238, 0.3)', background: 'rgba(34, 211, 238, 0.055)' },
  messageHeader: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  messageSender: { minWidth: 0, maxWidth: '100%', fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  messageTime: { marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' },
  backstageBadge: { fontSize: 9, fontWeight: 800, color: '#93c5fd', background: 'rgba(59, 130, 246, 0.12)', borderRadius: 999, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: 0 },
  privateBadge: { fontSize: 9, fontWeight: 800, color: '#86efac', background: 'rgba(34, 197, 94, 0.13)', borderRadius: 999, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: 0 },
  privateMeta: { fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pinBadge: { fontSize: 9, fontWeight: 800, color: '#67e8f9', background: 'rgba(34, 211, 238, 0.12)', borderRadius: 999, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: 0 },
  starBadge: { fontSize: 9, fontWeight: 800, color: '#fbbf24', background: 'rgba(245, 158, 11, 0.14)', borderRadius: 999, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: 0 },
  messageContent: { margin: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--text-secondary)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  actionButton: { minHeight: 25, border: '1px solid var(--border)', borderRadius: 7, background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', padding: '0 8px', fontSize: 10, fontWeight: 800, cursor: 'pointer' },
  actionButtonActive: { color: '#fbbf24', borderColor: 'rgba(245, 158, 11, 0.32)', background: 'rgba(245, 158, 11, 0.12)' },
  actionButtonPinned: { color: '#67e8f9', borderColor: 'rgba(34, 211, 238, 0.32)', background: 'rgba(34, 211, 238, 0.12)' },
  reactionButton: { minWidth: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--text-secondary)' },
  reactionEmoji: { fontSize: 14, lineHeight: 1 },
  reactionCount: { minWidth: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', borderRadius: 999, background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', fontSize: 9, lineHeight: 1 },
  composer: { display: 'grid', gridTemplateColumns: '1fr 38px', gap: 8, padding: 12, borderTop: '1px solid var(--border)', background: 'rgba(15, 23, 42, 0.92)' },
  input: { minWidth: 0, height: 38, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', padding: '0 12px', fontSize: 13, outline: 'none' },
  sendButton: { width: 38, height: 38, borderRadius: 8, border: 'none', background: 'var(--accent-solid)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
};
