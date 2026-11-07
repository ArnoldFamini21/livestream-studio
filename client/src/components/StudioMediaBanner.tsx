import { useEffect, useState } from 'react';
import { MediaAccessHelp } from './MediaAccessHelp.tsx';
import type { MediaAccessProblem } from '../utils/mediaAccessErrors.ts';

interface StudioMediaBannerProps {
  problem: MediaAccessProblem | null;
  onRetry: () => Promise<boolean>;
}

/**
 * In the studio, a camera or mic that did not start gets a visible card with
 * how to fix it and Try again, instead of a toggle that silently does nothing.
 */
export function StudioMediaBanner({ problem, onRetry }: StudioMediaBannerProps) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const key = problem ? `${problem.kind}:${problem.device}` : null;
  // A new problem (different device or reason) shows again after a dismiss.
  useEffect(() => {
    if (!key) setDismissedKey(null);
  }, [key]);
  if (!problem || dismissedKey === key) return null;
  return (
    <div className="studio-media-help">
      <MediaAccessHelp problem={problem} onRetry={onRetry} compact onDismiss={() => setDismissedKey(key)} />
    </div>
  );
}
