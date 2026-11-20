import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CHAT_REACTION_EMOJIS,
  CHAT_REACTION_LABELS,
  VIEWER_MESSAGE_MAX,
  VIEWER_NAME_MAX,
  VIEWER_QUESTION_MAX,
  VIEWER_REACTION_TYPES,
  type ViewerReactionType,
  type WatchChatMessage,
} from '@studio/shared';
import { postJson } from '../utils/apiClient.ts';
import { getWatchVoterId } from '../utils/watchPollVoting.ts';
import { readViewerName, saveViewerName, sendFailureLine, tidyViewerName } from '../utils/watchViewerChat.ts';
import { useWatchLive } from '../hooks/useWatchLive.ts';
import '../styles/watch-chat.css';

interface WatchChatPanelProps {
  watchId: string;
  /** The name the viewer gave when registering, used until they choose another. */
  registeredName: string;
  /** Reactions to float on the picture: other people's (from the server) and this viewer's own tap. */
  onFloat: (types: ViewerReactionType[]) => void;
  onCaptionsAvailable?: (available: boolean) => void;
}

type Status = { kind: 'info' | 'error'; text: string } | null;

/**
 * Live chat, reactions and questions on the watch page. Each part appears only
 * while the host has turned it on (the server enforces the same switches, so a
 * hidden control cannot be used by hand either). Everything shown is plain
 * text: a message is never read as a link or as markup.
 */
export function WatchChatPanel({ watchId, registeredName, onFloat, onCaptionsAvailable }: WatchChatPanelProps) {
  const { switches, messages, captionsAvailable, refresh, noteOwnReaction } = useWatchLive({ watchId, onReactions: onFloat });
  const viewerId = useMemo(() => getWatchVoterId(), []);
  const path = `/api/watch/${encodeURIComponent(watchId)}`;
  const [name, setName] = useState(() => readViewerName(registeredName));
  const [draft, setDraft] = useState('');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reactionBusy, setReactionBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previousMessages = useRef<WatchChatMessage[]>([]);
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => { onCaptionsAvailable?.(captionsAvailable); }, [captionsAvailable, onCaptionsAvailable]);

  // A registration name becomes the default only while the viewer has not chosen one.
  useEffect(() => {
    setName((current) => current || readViewerName(registeredName));
  }, [registeredName]);

  // Keep the newest message in view, unless the viewer scrolled up to read.
  useLayoutEffect(() => {
    const log = logRef.current;
    const previous = previousMessages.current;
    previousMessages.current = messages;
    if (!log) {
      nearBottom.current = true;
      setHasNew(false);
    } else if (nearBottom.current) {
      log.scrollTop = log.scrollHeight;
      setHasNew(false);
    } else {
      const newest = messages[messages.length - 1];
      if (newest && !previous.some((message) => message.id === newest.id)) setHasNew(true);
    }
  }, [messages, switches.chat]);

  const sendChat = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await postJson(`${path}/chat`, { viewerId, name: tidyViewerName(name), text });
      saveViewerName(name);
      setDraft((current) => current === draft ? '' : current);
      nearBottom.current = true;
      refresh();
    } catch (error) {
      setStatus({ kind: 'error', text: sendFailureLine(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, draft, name, path, refresh, viewerId]);

  const sendQuestion = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await postJson(`${path}/questions`, { viewerId, name: tidyViewerName(name), text });
      saveViewerName(name);
      setQuestion('');
      setAsking(false);
      setStatus({ kind: 'info', text: 'Thank you. Your question was sent to the host.' });
    } catch (error) {
      setStatus({ kind: 'error', text: sendFailureLine(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, name, path, question, viewerId]);

  const react = useCallback(async (type: ViewerReactionType) => {
    if (reactionBusy) return;
    setReactionBusy(true);
    setStatus(null);
    try {
      await postJson(`${path}/reactions`, { viewerId, reaction: type });
      // Float it at once; the next answer from the server will not float it a second time.
      noteOwnReaction(type);
      onFloat([type]);
    } catch (error) {
      setStatus({ kind: 'error', text: sendFailureLine(error) });
    } finally {
      // A short pause between taps; the server has its own limits too.
      window.setTimeout(() => setReactionBusy(false), 450);
    }
  }, [noteOwnReaction, onFloat, path, reactionBusy, viewerId]);

  if (!switches.chat && !switches.reactions && !switches.questions) return null;

  const nameField = (
    <label className="watch-chat-name-field">
      <span>Your name</span>
      <input value={name} maxLength={VIEWER_NAME_MAX} autoComplete="nickname" placeholder="Shown with what you send" onChange={(event) => setName(event.target.value)} onBlur={() => saveViewerName(name)} />
    </label>
  );

  return (
    <section className="watch-chat" aria-label="Chat, reactions and questions">
      {switches.chat && (
        <>
          <div className="watch-chat-head">
            <span className="watch-kicker">Live chat</span>
            <span className="watch-chat-hint">Messages are shown to everyone watching, and may be shown on the broadcast. Be kind.</span>
          </div>
          <div
            ref={logRef}
            className="watch-chat-log"
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            onScroll={(event) => {
              const el = event.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              if (nearBottom.current) setHasNew(false);
            }}
          >
            {messages.length === 0 && <p className="watch-chat-empty">No messages yet. Say hello.</p>}
            {messages.map((message) => (
              <article key={message.id} className="watch-chat-message" data-from={message.from}>
                <header>
                  <span className="watch-chat-author">{message.name}</span>
                  <span className="watch-chat-tag" data-from={message.from}>{message.from === 'studio' ? 'Studio' : 'Viewer'}</span>
                </header>
                <p>{message.text}</p>
              </article>
            ))}
          </div>
          {hasNew && (
            <button type="button" className="watch-chat-new" onClick={() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); nearBottom.current = true; setHasNew(false); }}>
              New messages ↓
            </button>
          )}
          <form className="watch-chat-form" onSubmit={(event) => void sendChat(event)}>
            {nameField}
            <div className="watch-chat-row">
              <input
                aria-label="Your message"
                value={draft}
                maxLength={VIEWER_MESSAGE_MAX}
                placeholder="Write a message…"
                autoComplete="off"
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" disabled={busy || !draft.trim()}>Send</button>
            </div>
            {draft.length >= VIEWER_MESSAGE_MAX - 50 && <span className="watch-chat-count">{draft.length} / {VIEWER_MESSAGE_MAX}</span>}
          </form>
        </>
      )}

      {(switches.reactions || switches.questions) && (
        <div className="watch-chat-actions">
          {switches.reactions && (
            <div className="watch-chat-reactions" role="group" aria-label="Send a reaction">
              {VIEWER_REACTION_TYPES.map((type) => (
                <button key={type} type="button" disabled={reactionBusy} aria-label={CHAT_REACTION_LABELS[type]} title={CHAT_REACTION_LABELS[type]} onClick={() => void react(type)}>
                  <span aria-hidden="true">{CHAT_REACTION_EMOJIS[type]}</span>
                </button>
              ))}
            </div>
          )}
          {switches.questions && !asking && (
            <button type="button" className="watch-chat-ask" onClick={() => { setAsking(true); setStatus(null); }}>Ask a question</button>
          )}
        </div>
      )}

      {switches.questions && asking && (
        <form className="watch-chat-form watch-chat-question" onSubmit={(event) => void sendQuestion(event)}>
          <strong>Ask the host a question</strong>
          {!switches.chat && nameField}
          {switches.chat && <p className="watch-chat-hint">Your question goes to the host, not to the chat. It is shown as from {tidyViewerName(name) || 'a viewer'}.</p>}
          <textarea
            aria-label="Your question"
            value={question}
            maxLength={VIEWER_QUESTION_MAX}
            rows={3}
            placeholder="Type your question…"
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="watch-chat-row">
            <button type="submit" disabled={busy || !question.trim()}>Send question</button>
            <button type="button" className="watch-chat-cancel" onClick={() => { setAsking(false); setQuestion(''); }}>Cancel</button>
          </div>
        </form>
      )}

      <p className={`watch-chat-status${status?.kind === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">{status?.text ?? ''}</p>
    </section>
  );
}
