import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductionRundown, ProductionRundownCommand, SignalMessage } from '@studio/shared';

interface Options {
  roomId: string | undefined;
  connected: boolean;
  canControl: boolean;
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
}

interface PendingRequest {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function useProductionRundown({ roomId, connected, canControl, send, addHandler }: Options) {
  const [state, setState] = useState<{ roomId: string; rundown: ProductionRundown } | null>(null);
  const pending = useRef<PendingRequest | null>(null);
  const access = useRef(canControl);
  access.current = canControl;

  const settle = useCallback((error?: string) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    clearTimeout(request.timer);
    if (error) request.reject(new Error(error));
    else request.resolve();
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const remove = addHandler(message => {
      if (message.type === 'room-joined' && message.payload.room.id === roomId) {
        const { features, productionRundown } = message.payload;
        setState(features?.productionRundown && productionRundown ? { roomId, rundown: productionRundown } : null);
      } else if (message.type === 'production-rundown-state' && access.current) {
        setState({ roomId, rundown: message.payload.rundown });
        if (pending.current?.requestId === message.payload.requestId) settle(message.payload.error);
      }
    });
    return () => {
      remove();
      settle('The studio was closed.');
    };
  }, [addHandler, roomId, settle]);

  useEffect(() => {
    if (!canControl) setState(null);
    if (!canControl || !connected) settle('The studio disconnected before confirming the change.');
  }, [canControl, connected, settle]);

  const rundown = canControl && state?.roomId === roomId ? state?.rundown ?? null : null;
  const update = useCallback((command: ProductionRundownCommand, baseRevision: number) => {
    if (!rundown || !connected) return Promise.reject(new Error('Reconnect to the studio before editing the rundown.'));
    if (pending.current) return Promise.reject(new Error('Wait for the previous rundown change.'));
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle('The studio did not confirm the change. Review the rundown before trying again.'), 8_000);
      pending.current = { requestId, timer, resolve, reject };
      send({ type: 'production-rundown-update', payload: { ...command, requestId, baseRevision } });
    });
  }, [connected, rundown, send, settle]);

  return { rundown, connected, update };
}
