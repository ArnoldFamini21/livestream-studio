import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { ChatMessageItem } from './ChatMessageItem.tsx';
import { getChatDraftKey, prepareStudioChatMessage, MAX_CHAT_MESSAGE_LENGTH } from '../utils/chatWorkspace.ts';
import {
  getPopoutChatChannelName, readPopoutChatSession,
  type PopoutChatCommand, type PopoutChatState,
} from '../utils/popoutChat.ts';
import '../styles/studio-chat.css';

type ChatMode = 'public' | 'social' | 'starred' | 'backstage' | 'direct';
type ConnectionStatus = 'waiting' | 'connected' | 'unavailable';

export function PopoutChat() {
  const { roomId = '' } = useParams<{ roomId: string }>();
  const location = useLocation();
  const sessionId = useMemo(() => readPopoutChatSession(location.search), [location.search]);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLElement>(null);
  const nearBottomRef = useRef(true);
  const [state, setState] = useState<PopoutChatState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('waiting');
  const [mode, setMode] = useState<ChatMode>('public');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = getChatDraftKey(mode);
  const input = drafts[draftKey] || '';
  const readOnly = mode === 'social' || mode === 'starred' || mode === 'direct';
  const connected = status === 'connected' && Boolean(state?.connected);
  const preparedMessage = prepareStudioChatMessage(input, mode, '', []);
  const canSend = connected && Boolean(preparedMessage);
  const supportsBroadcastChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window;
  const messages = state?.messages || [];
  const publicMessages = messages.filter((message) => !message.isBackstage && !message.recipientId);
  const pinnedMessage = publicMessages.reduce<ChatMessage | null>((latest, message) => {
    if (!message.pinned) return latest;
    if (!latest) return message;
    return Date.parse(message.pinnedAt || message.timestamp) >= Date.parse(latest.pinnedAt || latest.timestamp) ? message : latest;
  }, null);
  const visibleMessages = mode === 'backstage' ? messages.filter((message) => message.isBackstage)
    : mode === 'direct' ? messages.filter((message) => Boolean(message.recipientId))
      : mode === 'social' ? publicMessages.filter((message) => Boolean(message.source?.platform))
        : mode === 'starred' ? publicMessages.filter((message) => message.starred) : publicMessages;

  const postCommand = useCallback((command: PopoutChatCommand) => { channelRef.current?.postMessage(command); }, []);

  useEffect(() => {
    if (!supportsBroadcastChannel || !roomId || !sessionId) { setStatus('unavailable'); return; }
    const channel = new BroadcastChannel(getPopoutChatChannelName(roomId, sessionId));
    channelRef.current = channel;
    setStatus('waiting');
    const timeout = window.setTimeout(() => setStatus((current) => current === 'connected' ? current : 'unavailable'), 4_000);
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
    if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [visibleMessages.length, mode]);

  const changeMode = (nextMode: ChatMode) => { nearBottomRef.current = true; setMode(nextMode); };
  const handleSend = () => {
    if (!connected || !preparedMessage) return;
    postCommand({ type: 'send-message', payload: { content: preparedMessage.content, isBackstage: preparedMessage.isBackstage } });
    setDrafts((previous) => ({ ...previous, [draftKey]: '' }));
  };
  const handleReact = (messageId: string, reaction: ChatReactionType) => { if (connected) postCommand({ type: 'react', payload: { messageId, reaction } }); };
  const handleToggleStar = (messageId: string, starred: boolean) => { if (connected) postCommand({ type: 'toggle-star', payload: { messageId, starred } }); };
  const handleTogglePin = (messageId: string, pinned: boolean) => { if (connected) postCommand({ type: 'toggle-pin', payload: { messageId, pinned } }); };
  const modeLabel = mode === 'backstage' ? 'Backstage' : mode === 'direct' ? 'Direct' : mode === 'social' ? 'Social' : mode === 'starred' ? 'Starred' : 'Public';

  return (
    <main className="studio-chat" style={{ height: '100dvh', background: 'var(--bg-primary)', overflow: 'hidden' }}>
      <header className="chat-toolbar">
        <h1 style={{ margin: 0, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state?.roomName || 'Chat'}</h1>
        <button type="button" className="chat-icon-button" onClick={() => window.close()} aria-label="Close window">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="chat-toolbar">
        <select className="chat-channel-select" aria-label="Chat channel" value={mode} onChange={(event) => changeMode(event.target.value as ChatMode)}>
          <option value="public">Public</option><option value="social">Social</option><option value="starred">Starred</option><option value="direct">Direct</option><option value="backstage">Backstage</option>
        </select>
        {!connected && <span className="chat-context-note" role="status">{status === 'waiting' ? 'Connecting…' : state && status === 'connected' ? 'Studio offline' : 'Disconnected'}</span>}
      </div>
      <section ref={messagesRef} className="chat-messages" role="log" aria-live="polite" aria-label={`${modeLabel} messages`} onScroll={() => {
        const container = messagesRef.current;
        if (container) nearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      }}>
        {pinnedMessage && (mode === 'public' || mode === 'starred') && <div className="chat-pinned-note"><span>Pinned</span><p>{pinnedMessage.content}</p></div>}
        {visibleMessages.length === 0 && <div className="chat-empty">
          <p>{status === 'connected' ? `No ${modeLabel.toLowerCase()} ${mode === 'backstage' ? 'notes' : mode === 'social' || mode === 'starred' ? 'comments' : 'messages'} yet` : 'Open chat from your studio'}</p>
          <span>{status !== 'connected' ? 'Keep the studio window open to stay connected.' : mode === 'backstage' ? 'Notes for the production team.' : mode === 'direct' ? 'Your private messages appear here.' : mode === 'social' ? 'Connect platform comments in the studio.' : mode === 'starred' ? 'Save public comments from their message menu.' : 'Messages are visible to everyone in the studio.'}</span>
        </div>}
        {visibleMessages.map((message) => <ChatMessageItem key={message.id} message={message} isMine={message.senderName === state?.senderName} onReact={connected ? handleReact : undefined} onToggleStar={connected ? handleToggleStar : undefined} onTogglePin={connected ? handleTogglePin : undefined} />)}
        <div ref={bottomRef} />
      </section>
      <footer className="chat-composer">
        {readOnly ? <div className="chat-context-note">{mode === 'direct' ? 'Send private messages from the studio window.' : <button type="button" className="chat-channel-select" onClick={() => changeMode('public')}>Write in Public chat</button>}</div> : <>
          <p className="chat-context-note">{mode === 'backstage' ? 'Only visible to the backstage team' : 'Visible to everyone in the studio'}</p>
          {input.length >= 1800 && <p className="chat-context-note" style={{ textAlign: 'right' }}>{input.length}/{MAX_CHAT_MESSAGE_LENGTH}</p>}
          <div className="chat-input-row">
            <input className="chat-input" aria-label={`${modeLabel} message`} placeholder={mode === 'backstage' ? 'Write a backstage note…' : 'Write a message…'} value={input} maxLength={MAX_CHAT_MESSAGE_LENGTH} disabled={!connected} onChange={(event) => { const value = event.target.value; setDrafts((previous) => ({ ...previous, [draftKey]: value })); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) handleSend(); }} />
            <button type="button" className="chat-send" onClick={handleSend} disabled={!canSend} aria-label="Send message">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14" /></svg>
            </button>
          </div>
        </>}
      </footer>
    </main>
  );
}
