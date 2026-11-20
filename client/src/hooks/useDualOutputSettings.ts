import { useCallback, useEffect, useState } from 'react';
import type { SecondaryProgramLayout } from '../utils/dualOutput.ts';

interface DualOutputSettings {
  enabled: boolean;
  layout: SecondaryProgramLayout;
}

const DEFAULT: DualOutputSettings = { enabled: false, layout: 'spotlight' };

function storageKey(roomId: string) {
  return `livestream-studio:dual-output:${roomId}`;
}

function load(roomId: string | undefined): DualOutputSettings {
  if (!roomId) return DEFAULT;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(roomId)) || 'null');
    return {
      enabled: value?.enabled === true,
      layout: value?.layout === 'grid' || value?.layout === 'solo' ? value.layout : 'spotlight',
    };
  } catch {
    return DEFAULT;
  }
}

export function useDualOutputSettings(roomId: string | undefined) {
  const [saved, setSaved] = useState(() => ({ roomId, config: load(roomId) }));
  const current = saved.roomId === roomId ? saved.config : DEFAULT;
  useEffect(() => {
    setSaved((previous) => previous.roomId === roomId ? previous : { roomId, config: load(roomId) });
  }, [roomId]);

  const update = useCallback((patch: Partial<DualOutputSettings>) => {
    setSaved((previous) => {
      const config = { ...(previous.roomId === roomId ? previous.config : load(roomId)), ...patch };
      return { roomId, config };
    });
  }, [roomId]);

  useEffect(() => {
    if (!roomId || saved.roomId !== roomId) return;
    try {
      localStorage.setItem(storageKey(roomId), JSON.stringify(saved.config));
    } catch {
      // The current studio still works when browser storage is unavailable.
    }
  }, [roomId, saved]);
  return [current, update] as const;
}
