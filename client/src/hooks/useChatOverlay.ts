import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyChatOverlayPatch,
  chatOverlayStateToPatch,
  chatOverlayStatesEqual,
  decideChatOverlayOnJoin,
  defaultChatOverlayState,
  expireChatOverlayPending,
  loadSavedChatOverlayState,
  normalizeChatOverlaySeq,
  normalizeChatOverlayState,
  reconcileChatOverlay,
  CHAT_OVERLAY_PENDING_TTL_MS,
  type ChatMessage,
  type ChatOverlayPatch,
  type ChatOverlayState,
  type Participant,
  type PendingChatOverlayPatch,
  type SignalMessage,
} from '@studio/shared';
import { idsToFreeze, selectOverlayComments, type ChatOverlayComment } from '../utils/chatOverlayComments.ts';
import type { ChatOverlayLayoutSettings } from '../utils/chatOverlayLayout.ts';

interface UseChatOverlayOptions {
  roomId: string | undefined;
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  /** Admitted host or co-host: the only people who may change the overlay. */
  canControl: boolean;
  /** This participant is the host (not a co-host): only the host may publish its browser copy to a server that holds none. */
  isHost: boolean;
  chatMessages: ChatMessage[];
  participants: Map<string, Participant>;
}

export interface ChatOverlayControls {
  state: ChatOverlayState;
  /** Comments the overlay may show now, oldest first (empty while the overlay is off). */
  comments: ChatOverlayComment[];
  /** Stable while size, layout and side stay the same (layout caches compare it by reference). */
  layoutSettings: ChatOverlayLayoutSettings;
  /** Applies a change here at once and sends it to the other operators when the server supports it. */
  update: (patch: ChatOverlayPatch) => void;
  /** Freeze or resume the overlay; freezing keeps exactly the comments visible right now. */
  setPaused: (paused: boolean) => void;
  /** The preview reports which comments it is showing, so Pause can freeze them. */
  reportVisibleIds: (ids: string[]) => void;
  /** The server advertised the feature, so changes sync to co-hosts and survive a reload. */
  serverSupported: boolean;
}

const EMPTY_COMMENTS: ChatOverlayComment[] = [];
const storageKey = (roomId: string) => `studio-chat-overlay:${roomId}`;

function commentsSignature(comments: ChatOverlayComment[]): string {
  return comments.map((comment) => `${comment.id}\u0001${comment.author}\u0001${comment.text}\u0001${comment.question ? 1 : 0}`).join('\u0002');
}

/**
 * Host-controlled on-screen chat. The settings live here and are the source
 * for the stage preview and the compositor. They sync to co-hosts through the
 * server when it advertises `features.chatOverlay` (a new client can meet an
 * old server for a few minutes during a deploy: then everything keeps working
 * locally), and are kept in this browser so a reload brings them back.
 */
export function useChatOverlay({ roomId, send, addHandler, canControl, isHost, chatMessages, participants }: UseChatOverlayOptions): ChatOverlayControls {
  const [state, setState] = useState<ChatOverlayState>(defaultChatOverlayState);
  const [serverSupported, setServerSupported] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const serverSupportedRef = useRef(false);
  const visibleIdsRef = useRef<string[]>([]);
  const commentsRef = useRef<ChatOverlayComment[]>(EMPTY_COMMENTS);
  const restoredRef = useRef(false);
  // Changes sent and not yet answered stay applied on top of whatever the server says.
  const pendingRef = useRef<PendingChatOverlayPatch[]>([]);
  const lastServerRef = useRef<ChatOverlayState | null>(null);
  const seqRef = useRef(0);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bring back this browser's copy (a reload). Pause is never restored: its comment ids are from an earlier session.
  useEffect(() => {
    restoredRef.current = false;
    if (!roomId) return;
    try {
      const raw = localStorage.getItem(storageKey(roomId));
      if (raw) setState(loadSavedChatOverlayState(JSON.parse(raw)));
    } catch {
      // Storage can be blocked; the overlay then simply starts off.
    }
    restoredRef.current = true;
  }, [roomId]);

  // Settings change rarely (a click), so write at once: a reload right after a change keeps it.
  useEffect(() => {
    if (!roomId || !restoredRef.current) return;
    try {
      localStorage.setItem(storageKey(roomId), JSON.stringify(state));
    } catch {
      // Storage can be full or blocked; the overlay still works.
    }
  }, [roomId, state]);

  // The same object comes back when nothing changed, so nothing re-renders.
  const showState = useCallback((next: ChatOverlayState) => {
    setState((current) => (chatOverlayStatesEqual(current, next) ? current : next));
  }, []);

  const clearExpiryTimer = useCallback(() => {
    if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;
  }, []);

  // A change nobody answered is given up after a few seconds: show the server's state again.
  const armExpiryTimer = useCallback(() => {
    clearExpiryTimer();
    const oldest = pendingRef.current[0];
    if (!oldest) return;
    const delay = Math.max(0, oldest.sentAt + CHAT_OVERLAY_PENDING_TTL_MS - Date.now());
    expiryTimerRef.current = setTimeout(() => {
      expiryTimerRef.current = null;
      const now = Date.now();
      if (lastServerRef.current) {
        const result = reconcileChatOverlay({ server: lastServerRef.current, pending: pendingRef.current, now });
        pendingRef.current = result.pending;
        showState(result.state);
      } else {
        pendingRef.current = expireChatOverlayPending(pendingRef.current, now);
      }
      armExpiryTimer();
    }, delay);
  }, [clearExpiryTimer, showState]);

  useEffect(() => clearExpiryTimer, [clearExpiryTimer]);

  const sendPatch = useCallback((patch: ChatOverlayPatch) => {
    seqRef.current += 1;
    pendingRef.current = [...pendingRef.current, { seq: seqRef.current, patch, sentAt: Date.now() }];
    armExpiryTimer();
    send({ type: 'chat-overlay-update', payload: { patch, seq: seqRef.current } });
  }, [armExpiryTimer, send]);

  useEffect(() => addHandler((message) => {
    if (message.type === 'room-joined') {
      const supported = message.payload.features?.chatOverlay === true;
      serverSupportedRef.current = supported;
      setServerSupported(supported);
      pendingRef.current = [];
      clearExpiryTimer();
      const server = message.payload.chatOverlay ? normalizeChatOverlayState(message.payload.chatOverlay) : null;
      lastServerRef.current = server;
      // The role in this very message is the truth: the isHost option catches up only after the next render.
      const host = message.payload.participant ? message.payload.participant.role === 'host' : isHostRef.current;
      const decision = decideChatOverlayOnJoin({ isHost: host, serverSupported: supported, serverHasState: server !== null, local: stateRef.current });
      if (server) {
        showState(server);
      } else if (decision === 'reset') {
        showState(defaultChatOverlayState());
      } else if (decision === 'publish') {
        // The one moment the whole state is sent: the server holds nothing (first join, or it restarted).
        sendPatch(chatOverlayStateToPatch(stateRef.current));
      }
    } else if (message.type === 'chat-overlay-updated') {
      const server = normalizeChatOverlayState(message.payload);
      lastServerRef.current = server;
      const result = reconcileChatOverlay({
        server,
        ack: normalizeChatOverlaySeq((message.payload as { ack?: unknown }).ack),
        pending: pendingRef.current,
        now: Date.now(),
      });
      pendingRef.current = result.pending;
      armExpiryTimer();
      showState(result.state);
    }
  }), [addHandler, armExpiryTimer, clearExpiryTimer, sendPatch, showState]);

  const update = useCallback((patch: ChatOverlayPatch) => {
    if (!canControl) return;
    setState((current) => applyChatOverlayPatch(current, patch));
    if (serverSupportedRef.current) sendPatch(patch);
  }, [canControl, sendPatch]);

  const setPaused = useCallback((paused: boolean) => {
    update(paused ? { paused: true, pausedIds: idsToFreeze(visibleIdsRef.current, commentsRef.current) } : { paused: false });
  }, [update]);

  const reportVisibleIds = useCallback((ids: string[]) => { visibleIdsRef.current = ids; }, []);

  const greenRoomIds = useMemo(() => {
    const ids = new Set<string>();
    participants.forEach((participant) => { if (participant.status === 'green-room') ids.add(participant.id); });
    return ids;
  }, [participants]);

  const selected = useMemo(
    () => (state.enabled ? selectOverlayComments({ messages: chatMessages, settings: state, greenRoomIds }) : EMPTY_COMMENTS),
    [chatMessages, state, greenRoomIds],
  );
  // New array identity only when what the overlay shows changed (reactions and the like do not).
  const stableRef = useRef<{ signature: string; comments: ChatOverlayComment[] }>({ signature: '', comments: EMPTY_COMMENTS });
  const signature = commentsSignature(selected);
  if (stableRef.current.signature !== signature) stableRef.current = { signature, comments: selected.length ? selected : EMPTY_COMMENTS };
  const comments = stableRef.current.comments;
  commentsRef.current = comments;

  const layoutSettings = useMemo<ChatOverlayLayoutSettings>(
    () => ({ size: state.size, layout: state.layout, side: state.side }),
    [state.size, state.layout, state.side],
  );

  return { state, comments, layoutSettings, update, setPaused, reportVisibleIds, serverSupported };
}
