import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StreamScreenKind } from '../utils/streamScreens.ts';

type BroadcastScreen = {
  kind: StreamScreenKind;
  activatedAtMs: number;
  automation?: 'waiting' | 'running';
};

export function useBroadcastScreens(setStageMuted: (muted: boolean) => void) {
  const [state, setState] = useState<{ screen: BroadcastScreen | null }>({ screen: null });
  const { screen } = state;
  const current = useRef<BroadcastScreen | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const replace = useCallback((next: BroadcastScreen | null) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    current.current = next;
    if (next?.automation) setStageMuted(true);
    setState({ screen: next });
  }, [setStageMuted]);

  // Restore only after React commits the new stage, and keep the shared
  // output track alive while inputs are gated.
  useLayoutEffect(() => {
    if (!state.screen?.automation && !current.current?.automation) setStageMuted(false);
  }, [state, setStageMuted]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setStageMuted(false);
  }, [setStageMuted]);

  const clear = useCallback(() => replace(null), [replace]);
  const show = useCallback((kind: StreamScreenKind) => {
    if (!current.current?.automation) replace({ kind, activatedAtMs: Date.now() });
  }, [replace]);
  const dismiss = useCallback(() => {
    if (current.current?.kind === 'ending' && current.current.automation) return;
    if (current.current?.automation === 'waiting') return;
    clear();
  }, [clear]);
  const prepareOpening = useCallback(() => {
    replace({ kind: 'starting', activatedAtMs: Date.now(), automation: 'waiting' });
  }, [replace]);
  const confirmOpening = useCallback((seconds: number) => {
    if (current.current?.automation !== 'waiting') return;
    replace({ kind: 'starting', activatedAtMs: Date.now(), automation: 'running' });
    timer.current = setTimeout(clear, seconds * 1000);
  }, [clear, replace]);
  const playClosing = useCallback((seconds: number, stop: () => void) => {
    replace({ kind: 'ending', activatedAtMs: Date.now(), automation: 'running' });
    timer.current = setTimeout(stop, seconds * 1000);
  }, [replace]);

  return { screen, current, show, dismiss, clear, prepareOpening, confirmOpening, playClosing };
}
