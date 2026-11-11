import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyChatOverlayPatch,
  defaultChatOverlayState,
  normalizeChatOverlayState,
  type ChatMessage,
  type ChatOverlayPatch,
  type ChatOverlayState,
  type Participant,
  type SignalMessage,
} from '@studio/shared';
import { selectOverlayComments, type ChatOverlayComment } from '../utils/chatOverlayComments.ts';
import type { ChatOverlayLayoutSettings } from '../utils/chatOverlayLayout.ts';

interface UseChatOverlayOptions {
  roomId: string | undefined;
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  connected: boolean;
  /** Admitted host or co-host: the only people who may change the overlay. */
  canControl: boolean;
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

function isDefaultState(state: ChatOverlayState): boolean {
  return JSON.stringify({ ...state, updatedAt: undefined }) === JSON.stringify(defaultChatOverlayState());
}

function stateToPatch(state: ChatOverlayState): ChatOverlayPatch {
  return {
    enabled: state.enabled,
    size: state.size,
    layout: state.layout,
    side: state.side,
    mode: state.mode,
    paused: state.paused,
    ...(state.paused ? { pausedIds: state.pausedIds } : {}),
    ...(state.hiddenIds.length ? { hide: state.hiddenIds } : {}),
    ...(state.shownIds.length ? { show: state.shownIds } : {}),
  };
}

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
export function useChatOverlay({ roomId, send, addHandler, connected, canControl, chatMessages, participants }: UseChatOverlayOptions): ChatOverlayControls {
  const [state, setState] = useState<ChatOverlayState>(defaultChatOverlayState);
  const [serverSupported, setServerSupported] = useState(false);
  const [joinTick, setJoinTick] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const serverSupportedRef = useRef(false);
  const serverHasStateRef = useRef(false);
  const visibleIdsRef = useRef<string[]>([]);
  const restoredRef = useRef(false);

  // Bring back this browser's copy (a reload, or a server that restarted).
  useEffect(() => {
    restoredRef.current = false;
    if (!roomId) return;
    try {
      const raw = localStorage.getItem(storageKey(roomId));
      if (raw) setState(normalizeChatOverlayState(JSON.parse(raw)));
    } catch {
      // Storage can be blocked; the overlay then simply starts off.
    }
    restoredRef.current = true;
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !restoredRef.current) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey(roomId), JSON.stringify(state));
      } catch {
        // Storage can be full or blocked; the overlay still works.
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [roomId, state]);

  useEffect(() => addHandler((message) => {
    if (message.type === 'room-joined') {
      const supported = message.payload.features?.chatOverlay === true;
      serverSupportedRef.current = supported;
      setServerSupported(supported);
      serverHasStateRef.current = Boolean(message.payload.chatOverlay);
      if (message.payload.chatOverlay) setState(normalizeChatOverlayState(message.payload.chatOverlay));
      setJoinTick((tick) => tick + 1);
    } else if (message.type === 'chat-overlay-updated') {
      serverHasStateRef.current = true;
      setState(normalizeChatOverlayState(message.payload));
    }
  }), [addHandler]);

  // The server knows nothing yet (first join, or it restarted): publish what this host has.
  useEffect(() => {
    if (!canControl || !connected || !serverSupportedRef.current || serverHasStateRef.current) return;
    if (isDefaultState(stateRef.current)) return;
    serverHasStateRef.current = true;
    send({ type: 'chat-overlay-update', payload: { patch: stateToPatch(stateRef.current) } });
  }, [canControl, connected, joinTick, send]);

  const update = useCallback((patch: ChatOverlayPatch) => {
    if (!canControl) return;
    setState((current) => applyChatOverlayPatch(current, patch));
    if (serverSupportedRef.current) {
      serverHasStateRef.current = true;
      send({ type: 'chat-overlay-update', payload: { patch } });
    }
  }, [canControl, send]);

  const setPaused = useCallback((paused: boolean) => {
    update(paused ? { paused: true, pausedIds: visibleIdsRef.current } : { paused: false });
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

  const layoutSettings = useMemo<ChatOverlayLayoutSettings>(
    () => ({ size: state.size, layout: state.layout, side: state.side }),
    [state.size, state.layout, state.side],
  );

  return { state, comments, layoutSettings, update, setPaused, reportVisibleIds, serverSupported };
}
