import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { formatChatTypingNames } from '../utils/chatTyping.ts';
import { getChatDraftKey, prepareStudioChatMessage, MAX_CHAT_MESSAGE_LENGTH } from '../utils/chatWorkspace.ts';
import { ChatMessageItem } from './ChatMessageItem.tsx';
import '../styles/studio-chat.css';

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

const TYPING_IDLE_MS = 2_500;

export function ChatPanel({
  messages, onSend, onReact, onTypingChange, onClose, senderName,
  directRecipients = [], typingUsers = [], title = 'Chat',
  placeholder = 'Type a message...', emptyText = 'No messages yet',
  emptyHint = 'Start the conversation!',
}: ChatPanelProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recipientId, setRecipientId] = useState('');
  const draftKey = getChatDraftKey(recipientId ? 'direct' : 'public', recipientId);
  const input = drafts[draftKey] || '';
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const typingStateRef = useRef<{ typing: boolean; recipientId?: string }>({ typing: false });
  const typingTimerRef = useRef<number | null>(null);
  const onTypingChangeRef = useRef(onTypingChange);
  const selectedRecipient = directRecipients.find((recipient) => recipient.id === recipientId);
  const recipientUnavailable = Boolean(recipientId) && !selectedRecipient;
  const preparedMessage = prepareStudioChatMessage(input, recipientId ? 'direct' : 'public', recipientId, directRecipients.map((recipient) => recipient.id));
  const canSend = Boolean(preparedMessage);
  const typingLabel = formatChatTypingNames(typingUsers);
  const pinnedMessage = messages.reduce<ChatMessage | null>((latest, message) => {
    if (!message.pinned || message.isBackstage || message.recipientId) return latest;
    if (!latest) return message;
    return Date.parse(message.pinnedAt || message.timestamp) >= Date.parse(latest.pinnedAt || latest.timestamp)
      ? message : latest;
  }, null);

  const clearTypingTimer = useCallback(() => {
    if (typingTimerRef.current === null) return;
    window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
  }, []);

  const emitTyping = useCallback((typing: boolean, nextRecipientId?: string) => {
    const handler = onTypingChangeRef.current;
    if (!handler) return;
    const current = typingStateRef.current;
    if (current.typing === typing && current.recipientId === nextRecipientId) return;
    typingStateRef.current = { typing, recipientId: nextRecipientId };
    handler(typing, nextRecipientId);
  }, []);

  const stopTyping = useCallback(() => {
    clearTypingTimer();
    const current = typingStateRef.current;
    if (current.typing) emitTyping(false, current.recipientId);
  }, [clearTypingTimer, emitTyping]);

  useEffect(() => {
    if (isNearBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  useEffect(() => { onTypingChangeRef.current = onTypingChange; }, [onTypingChange]);
  useEffect(() => stopTyping, [stopTyping]);
  useEffect(() => { if (recipientUnavailable) stopTyping(); }, [recipientUnavailable, stopTyping]);

  const setInput = (value: string) => setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  const handleInputChange = (value: string) => {
    setInput(value);
    clearTypingTimer();
    if (!value.trim() || recipientUnavailable) { stopTyping(); return; }
    const target = selectedRecipient?.id;
    emitTyping(true, target);
    typingTimerRef.current = window.setTimeout(() => {
      emitTyping(false, target);
      typingTimerRef.current = null;
    }, TYPING_IDLE_MS);
  };

  const handleSend = () => {
    if (!preparedMessage) return;
    stopTyping();
    onSend(preparedMessage.content, preparedMessage.recipientId);
    setInput('');
  };

  return (
    <section className="studio-chat" style={{ flex: '0 1 300px', width: 300, maxWidth: '100%', height: '100%', borderLeft: '1px solid var(--border)' }} aria-label={title}>
      <header className="chat-toolbar">
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
        <button type="button" className="chat-icon-button" onClick={onClose} aria-label="Close chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div ref={messagesContainerRef} className="chat-messages" role="log" aria-live="polite" aria-label={`${title} messages`} onScroll={() => {
        const container = messagesContainerRef.current;
        if (container) isNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      }}>
        {pinnedMessage && <div className="chat-pinned-note"><span>Pinned</span><p>{pinnedMessage.content}</p></div>}
        {messages.length === 0 && <div className="chat-empty"><p>{emptyText}</p><span>{emptyHint}</span></div>}
        {messages.map((message) => <ChatMessageItem key={message.id} message={message} isMine={message.senderName === senderName} onReact={onReact} />)}
        <div ref={bottomRef} />
      </div>
      <div className="chat-composer">
        {(directRecipients.length > 0 || recipientId) && <select className="chat-channel-select" value={recipientId} onChange={(event) => { stopTyping(); setRecipientId(event.target.value); }} aria-label="Chat recipient">
          <option value="">Everyone</option>
          {recipientUnavailable && <option value={recipientId} disabled>Participant left</option>}
          {directRecipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.name}{recipient.role ? ` (${recipient.role})` : ''}</option>)}
        </select>}
        {recipientUnavailable && <p className="chat-context-note" role="status">This participant has left. Choose a recipient to continue.</p>}
        {selectedRecipient && <p className="chat-context-note">Private message to {selectedRecipient.name}</p>}
        {typingLabel && <p className="chat-context-note" role="status">{typingLabel}</p>}
        {input.length >= 1800 && <p className="chat-context-note" style={{ textAlign: 'right' }}>{input.length}/{MAX_CHAT_MESSAGE_LENGTH}</p>}
        <div className="chat-input-row">
          <input className="chat-input" aria-label={selectedRecipient ? `Private message to ${selectedRecipient.name}` : `${title} message`} placeholder={selectedRecipient ? `Message ${selectedRecipient.name}…` : placeholder} value={input} maxLength={MAX_CHAT_MESSAGE_LENGTH} disabled={recipientUnavailable} onChange={(event) => handleInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) handleSend(); }} />
          <button type="button" className="chat-send" onClick={handleSend} disabled={!canSend} aria-label="Send message">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14" /></svg>
          </button>
        </div>
      </div>
    </section>
  );
}
