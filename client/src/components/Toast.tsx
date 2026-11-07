import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import {
  getToastDurationMs,
  getToastRole,
  pauseToastTimer,
  resumeToastTimer,
  selectToastsToKeep,
  type ToastTimerState,
  type ToastType,
} from '../utils/toastPolicy.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  exiting: boolean;
  persistent: boolean;
}

interface ToastContextValue {
  /**
   * Show a notice. Errors stay until dismissed (pass `durationMs` to change
   * that); warnings stay 8 s and others 5 s, paused while hovered or focused.
   */
  addToast: (message: string, type?: ToastType, options?: { durationMs?: number }) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

const EXIT_ANIMATION_MS = 180;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToastState] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);
  const setToasts = useCallback((update: Toast[] | ((prev: Toast[]) => Toast[])) => {
    const next = typeof update === 'function' ? update(toastsRef.current) : update;
    toastsRef.current = next;
    setToastState(next);
  }, []);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const timerStatesRef = useRef<Map<string, ToastTimerState>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const removeToast = useCallback((id: string) => {
    clearTimer(id);
    timerStatesRef.current.delete(id);
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_ANIMATION_MS);
  }, [clearTimer, setToasts]);

  const schedule = useCallback((id: string) => {
    const state = timerStatesRef.current.get(id);
    if (!state || state.startedAt === null) return;
    clearTimer(id);
    timersRef.current.set(id, setTimeout(() => removeToast(id), state.remainingMs));
  }, [clearTimer, removeToast]);

  const pause = useCallback((id: string) => {
    const state = timerStatesRef.current.get(id);
    if (!state) return;
    clearTimer(id);
    timerStatesRef.current.set(id, pauseToastTimer(state, Date.now()));
  }, [clearTimer]);

  const resume = useCallback((id: string) => {
    const state = timerStatesRef.current.get(id);
    if (!state) return;
    timerStatesRef.current.set(id, resumeToastTimer(state, Date.now()));
    schedule(id);
  }, [schedule]);

  const addToast = useCallback(
    (message: string, type: ToastType = 'info', options?: { durationMs?: number }) => {
      const durationMs = getToastDurationMs(type, options?.durationMs);
      const persistent = durationMs === 0;
      const current = toastsRef.current;
      // The same notice again restarts its timer instead of stacking a copy.
      const duplicate = current.find((t) => !t.exiting && t.message === message && t.type === type);
      const id = duplicate?.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (!duplicate) {
        const live = current.filter((t) => !t.exiting);
        const next = selectToastsToKeep([...live, { id, message, type, exiting: false, persistent }]);
        for (const dropped of live) {
          if (!next.includes(dropped)) {
            clearTimer(dropped.id);
            timerStatesRef.current.delete(dropped.id);
          }
        }
        setToasts(next);
      }
      if (!persistent) {
        timerStatesRef.current.set(id, { remainingMs: durationMs, startedAt: Date.now() });
        schedule(id);
      }
    },
    [clearTimer, schedule, setToasts]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const value = useMemo(() => ({ addToast }), [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast--${toast.type}${toast.exiting ? ' toast-exit' : ''}`}
            role={getToastRole(toast.type)}
            onMouseEnter={() => pause(toast.id)}
            onMouseLeave={() => resume(toast.id)}
            onFocus={() => pause(toast.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume(toast.id);
            }}
          >
            <span className="toast-icon" aria-hidden="true">{typeIcons[toast.type]}</span>
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => removeToast(toast.id)}
              aria-label="Dismiss notification"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const typeIcons: Record<ToastType, string> = {
  success: '✓',
  error: '!',
  warning: '!',
  info: 'i',
};
