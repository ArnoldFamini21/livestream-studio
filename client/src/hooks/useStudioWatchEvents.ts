import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignalMessage, WatchEventState } from '@studio/shared';

const EMPTY: WatchEventState = { callInsEnabled: false, callIns: [] };
type Invite = { token: string; expiresAt: string };
type Pending = { requestId: string; timer: ReturnType<typeof setTimeout>; resolve: (invite: Invite) => void; reject: (error: Error) => void };

interface Options {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  canControl: boolean;
  onNewCall: () => void;
}

export function useStudioWatchEvents({ send, addHandler, canControl, onNewCall }: Options) {
  const [state, setState] = useState(EMPTY);
  const [supported, setSupported] = useState(false);
  const pending = useRef<Pending | null>(null);
  const lastCalls = useRef<ReadonlySet<string>>(new Set());
  const announce = useRef(onNewCall);
  announce.current = onNewCall;

  useEffect(() => addHandler((message) => {
    if (message.type === 'room-joined' || message.type === 'watch-event-state') {
      if (message.type === 'room-joined') setSupported(message.payload.features?.watchEvents === true);
      const next = message.type === 'room-joined' ? message.payload.watchEvent || EMPTY : message.payload;
      if (message.type === 'watch-event-state' && next.callIns.some((call) => !lastCalls.current.has(call.id))) {
        announce.current();
      }
      lastCalls.current = new Set(next.callIns.map((call) => call.id));
      setState(next);
    } else if (message.type === 'watch-invite-issued' && pending.current?.requestId === message.payload.requestId) {
      const request = pending.current;
      pending.current = null;
      clearTimeout(request.timer);
      const { token, expiresAt, error } = message.payload;
      if (token && expiresAt) request.resolve({ token, expiresAt });
      else request.reject(new Error(error || 'The watch invite could not be created.'));
    }
  }), [addHandler]);

  useEffect(() => () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current.reject(new Error('The studio was closed.'));
    pending.current = null;
  }, []);

  const requestInvite = useCallback((): Promise<Invite> => {
    if (!canControl || !supported) return Promise.reject(new Error('Connect to the studio before creating a watch link.'));
    if (pending.current) return Promise.reject(new Error('Wait for the previous watch link.'));
    const requestId = `watch-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current = null;
        reject(new Error('The studio did not confirm the watch link.'));
      }, 8000);
      pending.current = { requestId, timer, resolve, reject };
      send({ type: 'watch-invite-request', payload: { requestId } });
    });
  }, [canControl, send, supported]);

  const setCallInsEnabled = useCallback((callInsEnabled: boolean) => {
    if (canControl && supported) send({ type: 'watch-event-settings', payload: { callInsEnabled } });
  }, [canControl, send, supported]);
  const decideCallIn = useCallback((id: string, decision: 'approve' | 'decline') => {
    if (canControl && supported) send({ type: 'watch-call-in-decide', payload: { id, decision } });
  }, [canControl, send, supported]);

  return { state, supported, requestInvite, setCallInsEnabled, decideCallIn };
}

export type StudioWatchEvents = ReturnType<typeof useStudioWatchEvents>;
