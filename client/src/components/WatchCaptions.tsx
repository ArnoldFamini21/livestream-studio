import { useEffect, useState } from 'react';
import type { WatchCaptionCue, WatchCaptionSnapshot } from '@studio/shared';
import { requestJson } from '../utils/apiClient.ts';
import { selectWatchCaption } from '../utils/watchCaptions.ts';

interface WatchCaptionsProps {
  watchId: string;
  watchAccessToken?: string;
  readPlaybackTime: () => number | null;
}

export function WatchCaptions({ watchId, watchAccessToken, readPlaybackTime }: WatchCaptionsProps) {
  const [snapshot, setSnapshot] = useState<WatchCaptionSnapshot | null>(null);
  const [show, setShow] = useState(false);
  const [caption, setCaption] = useState<WatchCaptionCue | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function load() {
      try {
        const data = await requestJson<WatchCaptionSnapshot>('/api/watch/' + encodeURIComponent(watchId) + '/captions', {
          signal: controller.signal,
          ...(watchAccessToken ? { headers: { Authorization: 'Bearer ' + watchAccessToken } } : {}),
        });
        if (!controller.signal.aborted) setSnapshot(data);
      } catch {
        if (!controller.signal.aborted) setSnapshot(null);
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void load(), 2400);
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [watchAccessToken, watchId]);

  useEffect(() => {
    if (!show || !snapshot?.enabled) {
      setCaption(null);
      return;
    }
    const tick = () => setCaption(selectWatchCaption(snapshot.cues, readPlaybackTime()));
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [readPlaybackTime, show, snapshot]);

  if (!snapshot?.enabled) return null;
  return (
    <>
      <button className="watch-captions-toggle" type="button" aria-label="Closed captions" aria-pressed={show} onClick={() => setShow(value => !value)}>CC</button>
      {show && caption && (
        <div className="watch-caption-line" lang={snapshot.language}>
          {caption.speaker && <strong>{caption.speaker}: </strong>}{caption.text}
        </div>
      )}
    </>
  );
}
