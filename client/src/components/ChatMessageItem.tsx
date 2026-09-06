import { useRef } from 'react';
import type { ChatMessage, ChatReactionType } from '@studio/shared';
import { CHAT_REACTION_EMOJIS, CHAT_REACTION_LABELS, CHAT_REACTION_TYPES } from '@studio/shared';
import { isPublicChatMessage } from '../utils/chatWorkspace.ts';
import { StudioIcon } from './StudioIcon.tsx';

export interface ChatMessageItemProps {
  message: ChatMessage;
  isMine?: boolean;
  onReact?: (id: string, reaction: ChatReactionType) => void;
  onToggleStar?: (id: string, starred: boolean) => void;
  onTogglePin?: (id: string, pinned: boolean) => void;
  onFeature?: (message: ChatMessage) => void;
  onFlash?: (message: ChatMessage) => void;
  featured?: boolean;
}

export function ChatMessageItem({ message, isMine, onReact, onToggleStar, onTogglePin, onFeature, onFlash, featured }: ChatMessageItemProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  const isPublic = isPublicChatMessage(message);
  const hasActions = onReact || (isPublic && (onToggleStar || onTogglePin || onFeature || onFlash));
  const react = (reaction: ChatReactionType) => onReact?.(message.id, reaction);
  const act = (action: () => void) => {
    if (menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); }
    action();
  };
  const activeReactions = CHAT_REACTION_TYPES.filter(reaction => (message.reactions?.[reaction] || 0) > 0);
  const stamp = new Date(message.timestamp);
  const validTime = Number.isFinite(stamp.getTime());
  return <article className="chat-message-item" data-mine={isMine || undefined} aria-label={`Message from ${message.senderName}`}>
    <div className="chat-message-heading">
      <span className="chat-message-sender">{message.senderName}</span>
      {validTime && <time dateTime={stamp.toISOString()}>{stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
    </div>
    {(message.source?.platform || message.recipientId || message.isBackstage || message.pinned || message.starred) && <div className="chat-message-meta">
      {message.source?.platform && <span>{message.source.platform === 'youtube' ? 'YouTube' : 'Facebook'}</span>}
      {message.recipientId ? <span>Private · to {message.recipientName || 'participant'}</span> : message.isBackstage ? <span>Backstage</span> : null}
      {isPublic && message.pinned && <span>Pinned</span>}
      {isPublic && message.starred && <span>Starred</span>}
    </div>}
    <p className="chat-message-content">{message.content}</p>
    {featured && isPublic && <button type="button" className="chat-featured-note" onClick={() => onFeature?.(message)}>On stage · Hide</button>}
    {activeReactions.length > 0 && <div className="chat-reactions" aria-label="Message reactions">
      {activeReactions.map(reaction => <button type="button" key={reaction} disabled={!onReact} onClick={() => react(reaction)} aria-label={`${CHAT_REACTION_LABELS[reaction]}, ${message.reactions?.[reaction]} reactions`}>
        <span aria-hidden="true">{CHAT_REACTION_EMOJIS[reaction]}</span> {message.reactions?.[reaction]}
      </button>)}
    </div>}
    {hasActions && <details ref={menu} className="chat-message-options" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
    }}>
      <summary aria-label={`Message actions for ${message.senderName}: ${message.content.slice(0, 45)}`}><StudioIcon name="more" /></summary>
      <div className="chat-message-action-sheet">
        {onReact && <div className="chat-reaction-picker" aria-label="Add a reaction">{CHAT_REACTION_TYPES.map(reaction => <button type="button" key={reaction} aria-label={`${CHAT_REACTION_LABELS[reaction]} reaction`} title={CHAT_REACTION_LABELS[reaction]} onClick={() => act(() => react(reaction))}>{CHAT_REACTION_EMOJIS[reaction]}</button>)}</div>}
        {isPublic && <div className="chat-message-tools">
          {onFeature && <button type="button" onClick={() => act(() => onFeature(message))}>{featured ? 'Hide from stage' : 'Show on stage'}</button>}
          {onFlash && <button type="button" onClick={() => act(() => onFlash(message))}>Show briefly</button>}
          {onTogglePin && <button type="button" onClick={() => act(() => onTogglePin(message.id, !message.pinned))}>{message.pinned ? 'Unpin' : 'Pin message'}</button>}
          {onToggleStar && <button type="button" onClick={() => act(() => onToggleStar(message.id, !message.starred))}>{message.starred ? 'Remove star' : 'Star message'}</button>}
        </div>}
      </div>
    </details>}
  </article>;
}
