import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultViewerChatSwitches,
  type ViewerBlockScope,
  type ViewerChatStatePayload,
  type ViewerChatSwitches,
  type ViewerReactionType,
  type SignalMessage,
} from '@studio/shared';
import { createFloatingReaction, REACTION_OVERLAY_DURATION_MS, type FloatingReaction } from '../components/ReactionOverlay.tsx';
import { reactionsToFloat } from '../utils/watchViewerChat.ts';

interface UseViewerChatOptions {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  /** Admitted host or co-host: the only people who may change anything here. */
  canControl: boolean;
}

export interface ViewerChatControls {
  state: ViewerChatStatePayload;
  /** The server knows about viewer chat. An older server ignores these messages, so the controls say so. */
  serverSupported: boolean;
  setSwitch: (key: keyof ViewerChatSwitches, value: boolean) => void;
  removeMessage: (messageId: string) => void;
  blockViewer: (messageId: string, scope: ViewerBlockScope) => void;
  unblock: (blockId: string) => void;
  /** Reactions from the watch page, floating on this screen only. Never part of the broadcast picture. */
  floatingReactions: FloatingReaction[];
}

const EMPTY_STATE: ViewerChatStatePayload = { switches: defaultViewerChatSwitches(), blocks: [] };

/**
 * Host-side view of viewer chat: the three switches, the blocked viewers, and
 * watch-page reactions as counts. The server holds the truth (in memory, for
 * the life of the room) and sends it again to anyone who joins, so nothing is
 * kept in this browser.
 */
export function useViewerChat({ send, addHandler, canControl }: UseViewerChatOptions): ViewerChatControls {
  const [state, setState] = useState<ViewerChatStatePayload>(EMPTY_STATE);
  const [serverSupported, setServerSupported] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const sequenceRef = useRef(0);

  useEffect(() => addHandler((message) => {
    if (message.type === 'room-joined') {
      setServerSupported(message.payload.features?.viewerChat === true);
      setState(message.payload.viewerChat ?? EMPTY_STATE);
    } else if (message.type === 'viewer-chat-state') {
      setState(message.payload);
    } else if (message.type === 'viewer-reactions') {
      const { floats } = reactionsToFloat(message.payload.counts as Partial<Record<ViewerReactionType, number>>);
      if (floats.length === 0) return;
      const now = Date.now();
      const created = floats.map((type) => createFloatingReaction(type, ++sequenceRef.current, now));
      setFloatingReactions((current) => [...current.filter((item) => now - item.createdAt < REACTION_OVERLAY_DURATION_MS + 500), ...created].slice(-18));
      window.setTimeout(() => {
        setFloatingReactions((current) => current.filter((item) => !created.some((made) => made.id === item.id)));
      }, REACTION_OVERLAY_DURATION_MS + 400);
    }
  }), [addHandler]);

  const setSwitch = useCallback((key: keyof ViewerChatSwitches, value: boolean) => {
    if (canControl) send({ type: 'viewer-chat-settings-update', payload: { [key]: value } });
  }, [canControl, send]);
  const removeMessage = useCallback((messageId: string) => {
    if (canControl) send({ type: 'viewer-chat-remove', payload: { messageId } });
  }, [canControl, send]);
  const blockViewer = useCallback((messageId: string, scope: ViewerBlockScope) => {
    if (canControl) send({ type: 'viewer-chat-block', payload: { messageId, scope } });
  }, [canControl, send]);
  const unblock = useCallback((blockId: string) => {
    if (canControl) send({ type: 'viewer-chat-unblock', payload: { blockId } });
  }, [canControl, send]);

  return { state, serverSupported, setSwitch, removeMessage, blockViewer, unblock, floatingReactions };
}
