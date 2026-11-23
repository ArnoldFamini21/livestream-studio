import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StreamScreenKind } from '../utils/streamScreens.ts';

type BroadcastScreen = {
  kind: StreamScreenKind;
  activatedAtMs: number;
  automation?: 'waiting' | 'running';
  clipUrl?: string;
};

export function useBroadcastScreens(setStageMuted: (muted: boolean) => void) {
  const [state, setState] = useState<{ screen: BroadcastScreen | null }>({ screen: null });
  const { screen } = state;
  const current = useRef<BroadcastScreen | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishClosing = useRef<(() => void) | null>(null);

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

  const clear = useCallback(() => {
    finishClosing.current = null;
    replace(null);
  }, [replace]);
  const show = useCallback((kind: StreamScreenKind) => {
    if (!current.current?.automation) replace({ kind, activatedAtMs: Date.now() });
  }, [replace]);
  const dismiss = useCallback(() => {
    if (current.current?.kind === 'ending' && current.current.automation) return;
    if (current.current?.automation === 'waiting') return;
    clear();
  }, [clear]);
  const prepareOpening = useCallback((clipUrl?: string) => {
    replace({ kind: 'starting', activatedAtMs: Date.now(), automation: 'waiting', clipUrl });
  }, [replace]);
  const confirmOpening = useCallback((seconds: number) => {
    const prepared = current.current;
    if (prepared?.automation !== 'waiting') return;
    replace({ ...prepared, activatedAtMs: Date.now(), automation: 'running' });
    timer.current = setTimeout(clear, seconds * 1000);
  }, [clear, replace]);
  const playClosing = useCallback((seconds: number, stop: () => void, clipUrl?: string) => {
    finishClosing.current = stop;
    replace({ kind: 'ending', activatedAtMs: Date.now(), automation: 'running', clipUrl });
    timer.current = setTimeout(stop, seconds * 1000);
  }, [replace]);

  const clipEnded = useCallback((clip: BroadcastScreen) => {
    if (current.current !== clip) return;
    if (clip.kind === 'starting') {
      clear();
      return;
    }
    // The recorder sends one-second chunks. Give the last frame and sound
    // time to enter the relay before sending its stop command.
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => finishClosing.current?.(), 1250);
  }, [clear]);

  return { screen, current, show, dismiss, clear, prepareOpening, confirmOpening, playClosing, clipEnded };
}
