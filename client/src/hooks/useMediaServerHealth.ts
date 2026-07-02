import { useCallback, useEffect, useState } from 'react';
import {
  buildInitialMediaServerHealth,
  checkMediaServerHealth,
  type MediaServerHealth,
} from '../utils/mediaServerHealth.ts';

const MEDIA_SERVER_HEALTH_REFRESH_MS = 60_000;

export function useMediaServerHealth(): {
  health: MediaServerHealth;
  refresh: () => Promise<MediaServerHealth>;
} {
  const [health, setHealth] = useState<MediaServerHealth>(() => buildInitialMediaServerHealth());

  const refresh = useCallback(async () => {
    setHealth((current) => ({
      ...current,
      status: 'checking',
      message: 'Checking media-server readiness...',
    }));
    const next = await checkMediaServerHealth();
    setHealth(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const next = await checkMediaServerHealth();
      if (!cancelled) setHealth(next);
    };

    void run();
    const timer = window.setInterval(() => {
      void run();
    }, MEDIA_SERVER_HEALTH_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return { health, refresh };
}
