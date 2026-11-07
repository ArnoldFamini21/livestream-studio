import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import {
  getWidgetTabCaptureOptions,
  getWidgetTabCaptureSupport,
  isTabCaptureTrack,
  limitTrackToElement,
  planWidgetCaptureCrops,
  WIDGET_CAPTURE_ATTRIBUTE,
  WIDGET_REGION_CAPTURE_WARNING,
  type WidgetCaptureMethod,
  type WidgetCaptureSources,
  type WidgetCaptureSupport,
} from '../utils/widgetTabCapture.ts';

export interface WidgetCaptureControls {
  support: WidgetCaptureSupport;
  active: boolean;
  starting: boolean;
  error: string | null;
  /** Widgets whose live picture goes out (the rest show a placeholder). */
  capturedWidgetIds: string[];
  /** Set while any widget is captured by box crop, which also takes UI drawn over it. */
  overlapWarning: string | null;
  start: () => void;
  stop: () => void;
}

interface CropEntry {
  element: Element;
  track: MediaStreamTrack;
  video: HTMLVideoElement;
  method: WidgetCaptureMethod;
}

function stopEntry(entry: CropEntry) {
  entry.video.pause();
  entry.video.srcObject = null;
  entry.track.stop();
}

/**
 * Opt-in tab capture for web widgets (see utils/widgetTabCapture.ts). One
 * getDisplayMedia capture of this tab; one cropped clone per visible widget,
 * re-cropped when a widget's element is replaced. The capture ends when the
 * host stops it, ends sharing from the browser bar, or leaves the studio.
 */
export function useWidgetTabCapture(
  stageRef: RefObject<HTMLElement>,
  visibleWidgetIds: string[]
): { controls: WidgetCaptureControls; sourcesRef: MutableRefObject<WidgetCaptureSources> } {
  const support = useMemo(() => getWidgetTabCaptureSupport(), []);
  const sourcesRef = useRef<WidgetCaptureSources>(new Map());
  const entriesRef = useRef(new Map<string, CropEntry>());
  const baseTrackRef = useRef<MediaStreamTrack | null>(null);
  const syncingRef = useRef<Promise<void>>(Promise.resolve());
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capturedWidgetIds, setCapturedWidgetIds] = useState<string[]>([]);
  const [regionCaptureInUse, setRegionCaptureInUse] = useState(false);
  const visibleKey = visibleWidgetIds.join('|');

  const publish = useCallback(() => {
    const sources: WidgetCaptureSources = new Map();
    for (const [id, entry] of entriesRef.current) sources.set(id, entry.video);
    sourcesRef.current = sources;
    setCapturedWidgetIds(Array.from(sources.keys()));
    setRegionCaptureInUse(Array.from(entriesRef.current.values()).some((entry) => entry.method === 'region'));
  }, []);

  const stop = useCallback(() => {
    for (const entry of entriesRef.current.values()) stopEntry(entry);
    entriesRef.current.clear();
    baseTrackRef.current?.stop();
    baseTrackRef.current = null;
    setActive(false);
    publish();
  }, [publish]);

  const sync = useCallback(() => {
    // Serialized: crops are async and must not race each other.
    syncingRef.current = syncingRef.current.then(async () => {
      const base = baseTrackRef.current;
      const stage = stageRef.current;
      if (!base || base.readyState !== 'live' || !stage) return;
      const visible = new Map<string, Element>();
      stage.querySelectorAll(`[${WIDGET_CAPTURE_ATTRIBUTE}]`).forEach((element) => {
        const id = element.getAttribute(WIDGET_CAPTURE_ATTRIBUTE);
        if (id) visible.set(id, element);
      });
      const current = new Map(Array.from(entriesRef.current, ([id, entry]) => [id, entry.element]));
      const plan = planWidgetCaptureCrops(current, visible);
      for (const id of plan.stop) {
        const entry = entriesRef.current.get(id);
        if (entry) stopEntry(entry);
        entriesRef.current.delete(id);
      }
      let failure: string | null = null;
      for (const id of plan.start) {
        const element = visible.get(id);
        if (!element) continue;
        const track = base.clone();
        try {
          const method = await limitTrackToElement(track, element);
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.srcObject = new MediaStream([track]);
          await video.play().catch(() => undefined);
          entriesRef.current.set(id, { element, track, video, method });
        } catch {
          track.stop();
          failure = 'Could not crop the capture to a widget. Choose "This tab" when the browser asks.';
        }
      }
      setError(failure);
      publish();
    });
    return syncingRef.current;
  }, [publish, stageRef]);

  const start = useCallback(() => {
    if (!support.supported || starting || baseTrackRef.current) return;
    setStarting(true);
    setError(null);
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia(getWidgetTabCaptureOptions());
        const [track] = stream.getVideoTracks();
        stream.getAudioTracks().forEach((audio) => audio.stop());
        if (!track) throw new Error('No video in the capture.');
        if (!isTabCaptureTrack(track)) {
          track.stop();
          throw new Error('Pick "This tab" so the widgets can be cropped from it.');
        }
        // The base track is only cloned; its own frames are never shown.
        baseTrackRef.current = track;
        track.addEventListener('ended', stop, { once: true });
        setActive(true);
        await sync();
      } catch (err) {
        const name = (err as { name?: string })?.name;
        setError(name === 'NotAllowedError' || name === 'AbortError'
          ? 'Tab capture was cancelled; viewers keep seeing a placeholder.'
          : err instanceof Error ? err.message : 'Tab capture failed.');
      } finally {
        setStarting(false);
      }
    })();
  }, [starting, stop, support.supported, sync]);

  // Widgets shown, hidden or re-rendered: crop clones follow their elements.
  useEffect(() => {
    if (!active) return;
    // After the commit, so new widget elements are in the stage.
    const timer = window.setTimeout(() => void sync(), 0);
    return () => window.clearTimeout(timer);
  }, [active, sync, visibleKey]);

  useEffect(() => () => {
    for (const entry of entriesRef.current.values()) stopEntry(entry);
    entriesRef.current.clear();
    baseTrackRef.current?.stop();
    baseTrackRef.current = null;
  }, []);

  return {
    controls: {
      support,
      active,
      starting,
      error,
      capturedWidgetIds,
      overlapWarning: active && regionCaptureInUse ? WIDGET_REGION_CAPTURE_WARNING : null,
      start,
      stop,
    },
    sourcesRef,
  };
}
