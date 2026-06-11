import { useEffect, useRef, useCallback, useState } from 'react';
import type { SignalMessage } from '@studio/shared';
import { resolveWebSocketUrl } from '../utils/apiClient.ts';

type MessageHandler = (message: SignalMessage) => void;

// After this many failed reconnect attempts in a row we stop trying and surface
// a 'reconnect_failed' state so the UI can prompt the user to manually retry.
const MAX_RECONNECT_ATTEMPTS = 12;

export function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const [connected, setConnected] = useState(false);
  const [reconnectFailed, setReconnectFailed] = useState(false);

  // Reconnection with exponential backoff (capped attempts).
  const reconnectAttemptsRef = useRef<number>(0);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalDisconnectRef = useRef<boolean>(false);

  // Message queue for offline messages
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
    if (connectTimerRef.current) return;

    intentionalDisconnectRef.current = false;

    const wsUrl = resolveWebSocketUrl();
    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null;
      if (intentionalDisconnectRef.current) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        console.log('WebSocket connected');
        setConnected(true);
        setReconnectFailed(false);

        // Reset reconnect attempts on successful connection
        reconnectAttemptsRef.current = 0;

        // Drain any queued messages
        drainMessageQueue(ws);
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        let message: SignalMessage;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          console.warn('Invalid WebSocket message:', e);
          return;
        }
        for (const handler of handlersRef.current) {
          handler(message);
        }
      };

      ws.onclose = (event) => {
        if (wsRef.current !== ws) return;
        console.log('WebSocket disconnected');
        setConnected(false);

        // Clear stale message queue from old session to avoid replaying outdated data
        messageQueueRef.current = [];

        // Reconnect on non-clean close, unless intentionally disconnected or out of attempts.
        if (intentionalDisconnectRef.current || event.wasClean) return;

        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
          setReconnectFailed(true);
          return;
        }

        const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        const delay = baseDelay * (0.5 + Math.random() * 0.5); // 50-100% of base delay (jitter)
        console.log(`Scheduling reconnection in ${Math.round(delay)}ms (attempt ${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          reconnectAttemptsRef.current++;
          connect();
        }, delay);
      };

      ws.onerror = (err) => {
        if (wsRef.current === ws && !intentionalDisconnectRef.current) {
          console.error('WebSocket error:', err);
        }
      };

      wsRef.current = ws;
    }, 0);
  }, [drainMessageQueue]);

  const disconnect = useCallback(() => {
    // Bug fix #6: Prevent reconnection on manual disconnect
    intentionalDisconnectRef.current = true;

    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }

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

  // After max attempts the UI calls this to kick off a fresh attempt cycle.
  const retry = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    setReconnectFailed(false);
    connect();
  }, [connect]);

  useEffect(() => {
    return () => {
      // Bug fix #6: Clean up reconnect timer on unmount
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      intentionalDisconnectRef.current = true;
      disconnect();
    };
  }, [disconnect]);

  return { connect, disconnect, send, addHandler, connected, reconnectFailed, retry };
}
