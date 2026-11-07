import { useEffect, useRef, useState } from 'react';
import { describeStudioStatusChange, type StudioBroadcastState } from '../utils/studioStatusAnnouncements.ts';

/** Tells screen-reader users (host and guests alike) when recording or going live starts and stops. */
export function StudioStatusAnnouncer({ recording, paused, live }: StudioBroadcastState) {
  const previousRef = useRef<StudioBroadcastState | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const next = { recording, paused, live };
    const text = describeStudioStatusChange(previousRef.current, next);
    previousRef.current = next;
    if (text) setMessage(text);
  }, [recording, paused, live]);

  return (
    <div className="studio-sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
