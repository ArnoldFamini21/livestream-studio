import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RtmpRelayStats, RtmpRelayReadiness } from './useRtmpRelay.ts';
import {
  INITIAL_TEST_STREAM_STATE,
  getGoLiveBlocker,
  describeSwitchFailure,
  getTestStartBlocker,
  isHeldBroadcastRefusal,
  isTestRelayInUse,
  testStreamReducer,
  type TestStreamEvent,
  type TestStreamState,
} from '../utils/testStreamMachine.ts';
import { evaluateTestStream, type TestStreamVerdict } from '../utils/testStreamVerdict.ts';
import { isRelayOperationCancelled, RelayOperationSlot, startAuthorizedRelay } from '../utils/relayOperation.ts';

/** The media server needs a moment to finish stopping a test before a broadcast may start. */
const MEDIA_SERVER_RELEASE_MS = 700;

interface UseTestStreamOptions {
  isHost: boolean;
  supported: boolean;
  unsupportedReason: string;
  relayStats: RtmpRelayStats;
  checkRelayReadiness: () => Promise<RtmpRelayReadiness>;
  requestToken: () => Promise<string>;
  /** Starts the relay as a test (no destination). */
  startTestRelay: (token: string, refreshToken: () => Promise<string>) => Promise<void>;
  stopRelay: () => void;
  /** Tells the room a test started or ended. */
  announce: (active: boolean) => void;
  /** The normal Go Live path with all its checks; true when the broadcast started. */
  goLive: () => Promise<boolean>;
  /** Why the real broadcast could not start (invalid destinations), or null; checked before the test ends. */
  getGoLiveIssue: () => string | null;
  /** Why the last Go Live attempt failed, in plain words, or null when unknown. */
  getGoLiveFailureReason: () => string | null;
  /** A real broadcast is live or starting. */
  isLive: boolean;
  isGoLiveStarting: () => boolean;
  /** Called whenever the relay becomes busy with a test or free again. */
  onRelayInUseChange: (inUse: boolean) => void;
}

export interface TestStreamControls {
  state: TestStreamState;
  /** Why the test cannot start or an error to show; null when there is nothing to say. */
  notice: string | null;
  startBlocker: string | null;
  health: TestStreamVerdict | null;
  startTest: () => Promise<void>;
  endTest: () => void;
  goLiveNow: () => Promise<void>;
  dismiss: () => void;
  /** Wire to the relay's "stopped for good" callback. */
  handleRelayLost: (message: string) => boolean;
  /** Wire to the Go Live button; null when the normal path may run. */
  getNormalGoLiveBlocker: () => string | null;
}

export function useTestStream(options: UseTestStreamOptions): TestStreamControls {
  const [state, setState] = useState<TestStreamState>(INITIAL_TEST_STREAM_STATE);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const slotRef = useRef(new RelayOperationSlot());

  const dispatch = useCallback((event: TestStreamEvent): TestStreamState => {
    const previous = stateRef.current;
    const next = testStreamReducer(previous, event);
    if (next === previous) return next;
    stateRef.current = next;
    setState(next);
    if (isTestRelayInUse(previous) !== isTestRelayInUse(next)) optionsRef.current.onRelayInUseChange(isTestRelayInUse(next));
    return next;
  }, []);

  // The real broadcast owns the relay once it is live.
  useEffect(() => {
    dispatch({ type: options.isLive ? 'LIVE_ON' : 'LIVE_OFF' });
  }, [dispatch, options.isLive]);

  // A reconnect makes the media server open a new private address.
  const outputWatchId = options.relayStats.testOutputWatchId;
  useEffect(() => {
    if (outputWatchId) dispatch({ type: 'OUTPUT_CHANGED', watchId: outputWatchId });
  }, [dispatch, outputWatchId, state.phase]);

  const startBlocker = getTestStartBlocker(state, {
    supported: options.supported,
    unsupportedReason: options.unsupportedReason,
    isHost: options.isHost,
  });

  const startTest = useCallback(async () => {
    const o = optionsRef.current;
    setLocalNotice(null);
    const blocker = getTestStartBlocker(stateRef.current, { supported: o.supported, unsupportedReason: o.unsupportedReason, isHost: o.isHost })
      || (o.isGoLiveStarting() || o.isLive ? 'A live broadcast is running or starting. A test cannot run at the same time.' : null);
    if (blocker) {
      if (stateRef.current.phase === 'live') dispatch({ type: 'START_REQUESTED' });
      setLocalNotice(blocker);
      return;
    }
    const operation = slotRef.current.begin();
    if (!operation) return;
    dispatch({ type: 'START_REQUESTED' });
    try {
      const readiness = await operation.run(o.checkRelayReadiness);
      operation.assertActive();
      if (readiness.status !== 'ready') throw new Error(readiness.message);
      await startAuthorizedRelay(
        operation,
        o.requestToken,
        (token) => optionsRef.current.startTestRelay(token, optionsRef.current.requestToken),
        () => {
          dispatch({ type: 'START_SUCCEEDED', watchId: null, startedAt: new Date().toISOString() });
          optionsRef.current.announce(true);
        }
      );
    } catch (error) {
      if (!operation.active || isRelayOperationCancelled(error)) return;
      optionsRef.current.stopRelay();
      dispatch({
        type: 'START_FAILED',
        message: error instanceof Error ? error.message : 'The test could not start.',
        refused: isHeldBroadcastRefusal(error),
      });
    } finally {
      slotRef.current.finish(operation);
    }
  }, [dispatch]);

  const endTest = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase !== 'testing' && phase !== 'starting') return;
    dispatch({ type: 'END_REQUESTED' });
    slotRef.current.cancel();
    optionsRef.current.stopRelay();
    optionsRef.current.announce(false);
    dispatch({ type: 'END_COMPLETED' });
  }, [dispatch]);

  const goLiveNow = useCallback(async () => {
    if (stateRef.current.phase !== 'testing') return;
    // Check the broadcast can start before the test is ended, so a mistake in
    // the destination list does not cost the test.
    const issue = optionsRef.current.getGoLiveIssue();
    if (issue) {
      setLocalNotice(issue);
      return;
    }
    setLocalNotice(null);
    dispatch({ type: 'GO_LIVE_REQUESTED' });
    slotRef.current.cancel();
    optionsRef.current.stopRelay();
    optionsRef.current.announce(false);
    await new Promise((resolve) => setTimeout(resolve, MEDIA_SERVER_RELEASE_MS));
    try {
      const started = await optionsRef.current.goLive();
      if (started) dispatch({ type: 'SWITCH_COMPLETED' });
      else dispatch({ type: 'SWITCH_FAILED', message: describeSwitchFailure(optionsRef.current.getGoLiveFailureReason()) });
    } catch (error) {
      dispatch({ type: 'SWITCH_FAILED', message: describeSwitchFailure(error instanceof Error ? error.message : null) });
    }
  }, [dispatch]);

  /** True when a test was running and took the news; false when it belongs to a broadcast. */
  const handleRelayLost = useCallback((message: string): boolean => {
    const phase = stateRef.current.phase;
    if (phase !== 'testing' && phase !== 'starting') return false;
    optionsRef.current.announce(false);
    dispatch({ type: 'RELAY_LOST', message: `The test stopped: ${message}` });
    return true;
  }, [dispatch]);

  const dismiss = useCallback(() => {
    setLocalNotice(null);
    dispatch({ type: 'DISMISS' });
  }, [dispatch]);

  // A test must never outlive the studio.
  useEffect(() => () => slotRef.current.cancel(), []);

  const stats = options.relayStats;
  const health = useMemo((): TestStreamVerdict | null => {
    if (state.phase !== 'testing' || !state.startedAt) return null;
    const now = Date.now();
    const upload = stats.uploadVideo;
    const encoder = stats.serverEncoder;
    return evaluateTestStream({
      elapsedMs: Math.max(0, now - Date.parse(state.startedAt)),
      connected: stats.status === 'live',
      reconnectAttempts: stats.reconnectAttempts,
      relayLatencyMs: stats.relayLatencyMs,
      video: {
        width: upload?.width ?? null,
        height: upload?.height ?? null,
        targetFps: upload?.frameRate ?? 30,
        encoderFps: encoder && encoder.fps !== null && encoder.fps > 0 ? encoder.fps : null,
        uploadKbps: stats.bitrateKbps,
        lastChunkAgoMs: stats.lastChunkAt ? now - stats.lastChunkAt : null,
      },
      audio: { peakDb: stats.audioPeakDb },
      drops: {
        droppedFrames: stats.droppedFrames,
        backlogSeconds: stats.sendBacklogSeconds,
        serverDroppedFrames: encoder?.droppedFrames ?? 0,
        serverSpeed: encoder?.speed ?? null,
      },
    });
    // stats.updatedAt ticks every second while the relay runs, which refreshes the elapsed time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.startedAt, stats, stats.updatedAt]);

  const getNormalGoLiveBlocker = useCallback(() => getGoLiveBlocker(stateRef.current), []);

  return {
    state,
    notice: localNotice || state.message,
    startBlocker,
    health,
    startTest,
    endTest,
    goLiveNow,
    dismiss,
    handleRelayLost,
    getNormalGoLiveBlocker,
  };
}
