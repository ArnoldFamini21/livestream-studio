import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatReactionType, Participant, ExternalChatPlatform, ExternalChatStatusPayload } from '@studio/shared';
import { ChatMessageItem } from './ChatMessageItem.tsx';
import { StudioIcon } from './StudioIcon.tsx';
import { FLASH_COMMENT_DURATION_MS, createHighlightedCommentFromChatMessage, isHighlightedCommentSource, type HighlightedComment } from './CommentHighlight.tsx';
import { buildChatTranscriptCsv, buildChatTranscriptFilename, type ChatTranscriptScope } from '../utils/chatTranscript.ts';
import { formatChatTypingNames } from '../utils/chatTyping.ts';
import { getExternalChatPlatformMetrics } from '../utils/externalChatMetrics.ts';
import { MAX_CHAT_MESSAGE_LENGTH, getChatDraftKey, getStudioChatMessages, prepareStudioChatMessage } from '../utils/chatWorkspace.ts';
import '../styles/studio-chat.css';

const channelLabels: Record<ChatTranscriptScope, string> = { public: 'Public chat', social: 'Social comments', starred: 'Starred messages', direct: 'Direct messages', backstage: 'Backstage' };

export function StudioChat({
  messages,
  onSend,
  onReact,
  onToggleStar,
  onTogglePin,
  externalChatStatuses,
  onConnectExternalChat,
  onDisconnectExternalChat,
  canManageExternalChat,
  highlightedComment,
  onHighlightComment,
  onFlashComment,
  onDismissComment,
  senderName,
  typingNames,
  onTypingChange,
  onOpenPopoutChat,
  participants,
  myParticipantId,
}: {
  messages: ChatMessage[];
  onSend: (c: string, isBackstage?: boolean, recipientId?: string) => void;
  onReact: (messageId: string, reaction: ChatReactionType) => void;
  onToggleStar: (messageId: string, starred: boolean) => void;
  onTogglePin: (messageId: string, pinned: boolean) => void;
  externalChatStatuses: Partial<Record<ExternalChatPlatform, ExternalChatStatusPayload>>;
  onConnectExternalChat: (platform: ExternalChatPlatform, liveChatId: string) => void;
  onDisconnectExternalChat: (platform: ExternalChatPlatform) => void;
  canManageExternalChat: boolean;
  highlightedComment: HighlightedComment | null;
  onHighlightComment: (comment: HighlightedComment) => void;
  onFlashComment: (comment: HighlightedComment) => void;
  onDismissComment: () => void;
  senderName: string;
  typingNames?: {
    public: string[];
    direct: string[];
    backstage: string[];
  };
  onTypingChange?: (typing: boolean, isBackstage?: boolean, recipientId?: string) => void;
  onOpenPopoutChat?: () => void;
  participants: Map<string, Participant>;
  myParticipantId: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<ChatTranscriptScope>('public');
  const [view, setView] = useState<'chat' | 'connections'>('chat');
  const [connectionIds, setConnectionIds] = useState({ youtube: '', facebook: '' });
  const [directRecipientId, setDirectRecipientId] = useState('');
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const channelRef = useRef<HTMLSelectElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const typingRef = useRef<{ isBackstage: boolean; recipientId?: string } | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTypingRef = useRef(onTypingChange);
  onTypingRef.current = onTypingChange;
  const draftKey = getChatDraftKey(mode, directRecipientId);
  const input = drafts[draftKey] || '';
  const readOnly = mode === 'social' || mode === 'starred';
  const directRecipients = Array.from(participants.values()).filter(person => person.id !== myParticipantId).sort((a, b) => a.name.localeCompare(b.name));
  const selectedRecipient = directRecipients.find(person => person.id === directRecipientId);
  const preparedMessage = prepareStudioChatMessage(input, mode, directRecipientId, directRecipients.map(person => person.id));
  const visibleMessages = useMemo(() => getStudioChatMessages(messages, mode, myParticipantId, directRecipientId), [messages, mode, myParticipantId, directRecipientId]);
  const pinnedMessage = getStudioChatMessages(messages, 'public', myParticipantId).filter(message => message.pinned).sort((a, b) => Date.parse(b.pinnedAt || b.timestamp) - Date.parse(a.pinnedAt || a.timestamp))[0];
  const errorCount = Object.values(externalChatStatuses).filter(status => status?.status === 'error').length;
  const activeTypingNames = readOnly ? [] : mode === 'backstage' ? typingNames?.backstage || [] : mode === 'direct' ? (typingNames?.direct || []).filter(name => !selectedRecipient || name === selectedRecipient.name) : typingNames?.public || [];
  const typingLabel = formatChatTypingNames(activeTypingNames);

  const stopTyping = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (typingRef.current) onTypingRef.current?.(false, typingRef.current.isBackstage, typingRef.current.recipientId);
    typingRef.current = null;
  };
  useEffect(() => stopTyping, []);
  useEffect(() => {
    if (mode === 'direct' && !selectedRecipient) stopTyping();
  }, [mode, selectedRecipient?.id]);
  useEffect(() => {
    if (nearBottom.current) containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'auto' });
    else setHasNewMessages(true);
  }, [visibleMessages.length, mode, directRecipientId, view]);

  const handleInputChange = (value: string) => {
    setDrafts(current => ({ ...current, [draftKey]: value }));
    if (!prepareStudioChatMessage(value, mode, directRecipientId, directRecipients.map(person => person.id))) { stopTyping(); return; }
    const target = { isBackstage: mode === 'backstage', ...(mode === 'direct' ? { recipientId: directRecipientId } : {}) };
    if (!typingRef.current) { typingRef.current = target; onTypingRef.current?.(true, target.isBackstage, target.recipientId); }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2500);
  };
  const handleModeChange = (nextMode: ChatTranscriptScope) => { stopTyping(); nearBottom.current = true; setHasNewMessages(false); setMode(nextMode); };
  const handleRecipientChange = (id: string) => { stopTyping(); nearBottom.current = true; setHasNewMessages(false); setDirectRecipientId(id); };
  const handleSend = () => {
    if (!preparedMessage) return;
    stopTyping();
    nearBottom.current = true;
    setHasNewMessages(false);
    onSend(preparedMessage.content, preparedMessage.isBackstage, preparedMessage.recipientId);
    setDrafts(current => ({ ...current, [draftKey]: '' }));
    composerRef.current?.focus();
  };
  const closeMenu = () => { if (menuRef.current) { menuRef.current.open = false; menuRef.current.querySelector('summary')?.focus(); } };
  const openConnections = () => { closeMenu(); stopTyping(); setView('connections'); requestAnimationFrame(() => backRef.current?.focus()); };
  const handleExport = () => {
    closeMenu();
    if (!visibleMessages.length) return;
    const url = URL.createObjectURL(new Blob([buildChatTranscriptCsv(visibleMessages, mode)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = buildChatTranscriptFilename(mode); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const handleFeature = (message: ChatMessage) => {
    if (isHighlightedCommentSource(highlightedComment, message.id) && highlightedComment?.displayMode !== 'flash') { onDismissComment(); return; }
    const comment = createHighlightedCommentFromChatMessage(message);
    if (comment) onHighlightComment(comment);
  };
  const handleFlash = (message: ChatMessage) => {
    const comment = createHighlightedCommentFromChatMessage(message, { id: `flash-${message.id}-${Date.now()}`, displayMode: 'flash', durationMs: FLASH_COMMENT_DURATION_MS });
    if (comment) onFlashComment(comment);
  };

  return <div className="studio-chat">
    {view === 'connections' ? <>
      <div className="chat-toolbar"><button ref={backRef} type="button" className="chat-icon-button" aria-label="Back to chat" onClick={() => { setView('chat'); requestAnimationFrame(() => channelRef.current?.focus()); }}>←</button><h3>Connections</h3></div>
      <div className="chat-connections">
        <p>Bring live comments into your chat.</p>
        {(['youtube', 'facebook'] as const).map(platform => <PlatformConnection key={platform} platform={platform} status={externalChatStatuses[platform]} messages={messages} canManage={canManageExternalChat}
          value={connectionIds[platform]} onChange={value => setConnectionIds(current => ({ ...current, [platform]: value }))}
          onConnect={() => onConnectExternalChat(platform, connectionIds[platform].trim())} onDisconnect={() => onDisconnectExternalChat(platform)} />)}
      </div>
    </> : <>
      <div className="chat-toolbar">
        <select ref={channelRef} className="chat-channel-select" aria-label="Chat channel" value={mode} onChange={event => handleModeChange(event.target.value as ChatTranscriptScope)}>
          {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <details ref={menuRef} className="chat-toolbar-menu" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); } }}>
          <summary aria-label="Chat options"><StudioIcon name="more" /></summary>
          <div><button type="button" onClick={openConnections}>Connections{errorCount ? ` · ${errorCount} needs attention` : ''}</button>
            {onOpenPopoutChat && <button type="button" onClick={() => { closeMenu(); onOpenPopoutChat(); }}>Open pop-out chat</button>}
            <button type="button" onClick={handleExport} disabled={!visibleMessages.length}>Export conversation</button></div>
        </details>
      </div>
      {errorCount > 0 && <button type="button" className="chat-connection-notice" onClick={openConnections}>A chat connection needs attention <span>→</span></button>}
      {mode === 'direct' && <div className="chat-recipient-row"><select className="chat-channel-select" aria-label="Private message recipient" value={directRecipientId} onChange={event => handleRecipientChange(event.target.value)}>
        <option value="">{directRecipients.length ? 'Choose a recipient' : 'No other participants'}</option>
        {directRecipientId && !selectedRecipient && <option value={directRecipientId} disabled>Recipient unavailable</option>}
        {directRecipients.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select></div>}
      {pinnedMessage && (mode === 'public' || mode === 'starred') && <div className="chat-pinned-note"><span>Pinned</span><p title={pinnedMessage.content}>{pinnedMessage.content}</p><button type="button" className="chat-icon-button" aria-label="Unpin message" onClick={() => onTogglePin(pinnedMessage.id, false)}>×</button></div>}
      <div ref={containerRef} className="chat-messages" role="log" aria-label={channelLabels[mode]} aria-live="polite" aria-relevant="additions text" onScroll={event => {
        const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (nearBottom.current) setHasNewMessages(false);
      }}>
        {visibleMessages.length === 0 && <div className="chat-empty">
          <p>{mode === 'social' ? 'Your audience joins here.' : mode === 'starred' ? 'Keep the good ones close.' : mode === 'direct' ? 'A space for private messages.' : mode === 'backstage' ? 'Behind the scenes.' : 'Start the conversation.'}</p>
          <span>{mode === 'social' ? 'Comments from YouTube and Facebook appear here.' : mode === 'starred' ? 'Star a public message to find it here.' : mode === 'direct' ? 'Choose a participant to send a private note.' : mode === 'backstage' ? 'Coordinate with the host and backstage team.' : 'Public messages appear here.'}</span>
          {mode === 'social' && canManageExternalChat && <button type="button" className="chat-text-button" onClick={openConnections}>Connect platforms</button>}
        </div>}
        {visibleMessages.map(message => <ChatMessageItem key={message.id} message={message} isMine={message.senderId === myParticipantId} onReact={onReact} onToggleStar={onToggleStar} onTogglePin={onTogglePin} onFeature={handleFeature} onFlash={handleFlash}
          featured={isHighlightedCommentSource(highlightedComment, message.id) && highlightedComment?.displayMode !== 'flash'} />)}
      </div>
      {hasNewMessages && <button type="button" className="chat-new-messages" onClick={() => { containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' }); nearBottom.current = true; setHasNewMessages(false); }}>New messages ↓</button>}
      {readOnly ? <div className="chat-readonly-note"><span>{mode === 'social' ? 'Replies stay on the connected platform.' : 'Your saved public messages.'}</span><button type="button" className="chat-text-button" onClick={() => handleModeChange('public')}>Go to public chat</button></div> : <div className="chat-composer">
        <p className="chat-context-note">{mode === 'backstage' ? 'Visible to the backstage team' : mode === 'direct' ? selectedRecipient ? `Private · to ${selectedRecipient.name}` : 'Choose a recipient to send privately' : 'Visible to everyone in the studio'}</p>
        {typingLabel && <p className="chat-typing" role="status">{typingLabel}</p>}
        <div className="chat-input-row"><input ref={composerRef} className="chat-input" aria-label={mode === 'backstage' ? 'Backstage message' : mode === 'direct' ? 'Private message' : 'Public message'} placeholder={mode === 'direct' && !selectedRecipient ? 'Choose a recipient first' : 'Write a message…'}
          value={input} maxLength={MAX_CHAT_MESSAGE_LENGTH} disabled={mode === 'direct' && !selectedRecipient} onChange={event => handleInputChange(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); handleSend(); }
          }} />
          <button type="button" className="chat-send" disabled={!preparedMessage} aria-label="Send message" onClick={handleSend}>↑</button>
        </div>
        {input.length >= 1800 && <span className="chat-character-count">{input.length} / {MAX_CHAT_MESSAGE_LENGTH}</span>}
      </div>}
    </>}
  </div>;
}

function PlatformConnection({ platform, status, messages, canManage, value, onChange, onConnect, onDisconnect }: {
  platform: ExternalChatPlatform; status?: ExternalChatStatusPayload; messages: ChatMessage[]; canManage: boolean; value: string; onChange: (value: string) => void; onConnect: () => void; onDisconnect: () => void;
}) {
  const name = platform === 'youtube' ? 'YouTube' : 'Facebook';
  const connected = status?.status === 'connected' || status?.status === 'connecting';
  const busy = status?.status === 'connecting';
  const metrics = getExternalChatPlatformMetrics(messages, platform, status);
  return <details className="chat-platform">
    <summary><span>{name}</span><small data-status={status?.status}>{status?.status === 'error' ? 'Needs attention' : busy ? 'Connecting…' : connected ? 'Connected' : 'Not connected'}</small></summary>
    <div>{canManage ? connected ? <button type="button" className="chat-secondary-button" onClick={onDisconnect}>Disconnect {name}</button> : <form onSubmit={event => { event.preventDefault(); if (value.trim()) onConnect(); }}>
      <label>{name === 'YouTube' ? 'Live chat ID' : 'Live video ID'}<input value={value} aria-label={`${name} ${platform === 'youtube' ? 'live chat ID' : 'live video ID'}`} onChange={event => onChange(event.target.value)} placeholder="Paste the ID" required /></label>
      <button type="submit" className="chat-secondary-button" disabled={!value.trim()}>Connect {name}</button>
    </form> : <p>The host can manage this connection.</p>}
    {status?.message && <p className={status.status === 'error' ? 'chat-error' : ''} role={status.status === 'error' ? 'alert' : undefined}>{status.message}</p>}
    {(connected || metrics.importedCount > 0) && <div className="chat-connection-details"><span>{metrics.importedLabel} · {metrics.activityLabel}</span>{metrics.nextPollLabel && <span>{metrics.nextPollLabel}</span>}</div>}
    </div>
  </details>;
}
