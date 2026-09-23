import {
  SIGNALING_HEARTBEAT_INTERVAL_MS,
  SIGNALING_WAKE_CHECK_TIMEOUT_MS,
  isSignalingStale,
  shouldReconnectSignaling,
} from '../utils/signalingRecovery.ts';
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
  // Liveness: any message from the server counts. A connection can die
  // without a close event (server restart, laptop sleep, network change);
  // without this the studio would look connected but miss every update,
  // such as a guest arriving in the waiting room.
  const lastMessageAtRef = useRef<number>(0);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectRef = useRef<() => void>(() => {});

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  /** Abandon a connection that stopped answering and open a fresh one now. */
  const replaceStaleConnection = useCallback((ws: WebSocket) => {
    if (wsRef.current !== ws || intentionalDisconnectRef.current) return;
    console.warn('Studio connection stopped responding; reconnecting');
    stopHeartbeat();
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    wsRef.current = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    setConnected(false);
    connectRef.current();
  }, [stopHeartbeat]);

  const sendHeartbeat = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'heartbeat', payload: { sentAt: Date.now() } }));
    } catch {
      // A failed send means the socket is gone; the next check replaces it.
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
        setConnected(true);
        setReconnectFailed(false);
        lastMessageAtRef.current = Date.now();
        stopHeartbeat();
        heartbeatTimerRef.current = setInterval(() => {
          if (wsRef.current !== ws) return;
          if (isSignalingStale(lastMessageAtRef.current, Date.now())) {
            replaceStaleConnection(ws);
            return;
          }
          sendHeartbeat(ws);
        }, SIGNALING_HEARTBEAT_INTERVAL_MS);

        // Reset reconnect attempts on successful connection
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        lastMessageAtRef.current = Date.now();
        let message: SignalMessage;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          console.warn('Invalid WebSocket message:', e);
          return;
        }
        if (message.type === 'heartbeat-ack') return;
        for (const handler of handlersRef.current) {
          handler(message);
        }
      };

      ws.onclose = (event) => {
        if (wsRef.current !== ws) return;
        stopHeartbeat();
        setConnected(false);

        // Planned restarts close cleanly too; preserve deliberate departures.
        if (!shouldReconnectSignaling(event.code, intentionalDisconnectRef.current)) return;

        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
          setReconnectFailed(true);
          return;
        }

        const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        const delay = baseDelay * (0.5 + Math.random() * 0.5); // 50-100% of base delay (jitter)
        console.info(`Scheduling reconnection in ${Math.round(delay)}ms (attempt ${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})`);
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
  }, [replaceStaleConnection, sendHeartbeat, stopHeartbeat]);
  connectRef.current = connect;

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

    stopHeartbeat();
    wsRef.current?.close();
    wsRef.current = null;
  }, [stopHeartbeat]);

  // Waking the laptop, reconnecting to a network, or returning to the tab are
  // exactly when a connection may have died silently: check it right away.
  useEffect(() => {
    let probeTimer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (intentionalDisconnectRef.current) return;
      if (document.visibilityState === 'hidden') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (!reconnectTimerRef.current && !connectTimerRef.current) connectRef.current();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const probeSentAt = Date.now();
      sendHeartbeat(ws);
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = setTimeout(() => {
        probeTimer = null;
        if (wsRef.current === ws && lastMessageAtRef.current < probeSentAt) replaceStaleConnection(ws);
      }, SIGNALING_WAKE_CHECK_TIMEOUT_MS);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      window.removeEventListener('focus', check);
      if (probeTimer) clearTimeout(probeTimer);
    };
  }, [replaceStaleConnection, sendHeartbeat]);

  const send = useCallback((message: SignalMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
    // Room state is restored after rejoining. Never replay offline media or
    // broadcast commands belonging to a disconnected participant.
  }, []);

  const addHandler = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  // After max attempts the UI calls this to kick off a fresh attempt cycle.
  const retry = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
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
