import { useEffect, useRef, useCallback, useState } from 'react';
import type { SignalMessage } from '@studio/shared';

type MessageHandler = (message: SignalMessage) => void;

export function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const [connected, setConnected] = useState(false);

  // Bug fix #6: Reconnection with exponential backoff
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalDisconnectRef = useRef<boolean>(false);

  // Bug fix #7: Message queue for offline messages
  const messageQueueRef = useRef<SignalMessage[]>([]);

  // Bug fix #7: Drain queued messages
  const drainMessageQueue = useCallback((ws: WebSocket) => {
    while (messageQueueRef.current.length > 0) {
      const msg = messageQueueRef.current.shift()!;
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    // Bug fix #8: Guard against OPEN and CONNECTING states
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    intentionalDisconnectRef.current = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);

      // Bug fix #6: Reset reconnect attempts on successful connection
      reconnectAttemptsRef.current = 0;

      // Bug fix #7: Drain any queued messages
      drainMessageQueue(ws);
    };

    ws.onmessage = (event) => {
      try {
        const message: SignalMessage = JSON.parse(event.data);
        for (const handler of handlersRef.current) {
          handler(message);
        }
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    ws.onclose = (event) => {
      console.log('WebSocket disconnected');
      setConnected(false);

      // Bug fix #6: Reconnect on non-clean close, unless intentionally disconnected
      if (!intentionalDisconnectRef.current && !event.wasClean) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        console.log(`Scheduling reconnection in ${delay}ms (attempt ${reconnectAttemptsRef.current + 1})`);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          reconnectAttemptsRef.current++;
          connect();
        }, delay);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    wsRef.current = ws;
  }, [drainMessageQueue]);

  const disconnect = useCallback(() => {
    // Bug fix #6: Prevent reconnection on manual disconnect
    intentionalDisconnectRef.current = true;

    // Bug fix #6: Clear any pending reconnection timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const send = useCallback((message: SignalMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      // Bug fix #7: Queue messages when not connected
      messageQueueRef.current.push(message);
    }
  }, []);

  const addHandler = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    return () => {
      // Bug fix #6: Clean up reconnect timer on unmount
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      intentionalDisconnectRef.current = true;
      disconnect();
    };
  }, [disconnect]);

  return { connect, disconnect, send, addHandler, connected };
}
