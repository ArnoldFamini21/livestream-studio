import { useCallback, useEffect, useState } from 'react';
import type { ScreenVolumeView } from './mixControls.ts';
import {
  EMPTY_SCREEN_VOLUME_NOTICE_STATE,
  decideScreenVolumeAdvice,
  markScreenVolumeNoticeAnswered,
  type ScreenVolumeAdvice,
  type ScreenVolumeNoticeState,
} from './screenVolumeNotice.ts';

const NOTHING: ScreenVolumeAdvice = { notice: null, marker: null };

/**
 * Runs the screen-volume rule (see screenVolumeNotice.ts) for this browser.
 * `answer` is called when the host presses either button on the notice.
 */
export function useScreenVolumeNotice(input: {
  view: ScreenVolumeView;
  percent: number;
  soundShareKeys: readonly string[];
}): { advice: ScreenVolumeAdvice; answer: () => void } {
  const [current, setCurrent] = useState<{ state: ScreenVolumeNoticeState; advice: ScreenVolumeAdvice }>({
    state: EMPTY_SCREEN_VOLUME_NOTICE_STATE,
    advice: NOTHING,
  });
  const { percent } = input;
  const viewKind = input.view.kind;
  const keysKey = input.soundShareKeys.join('|');

  useEffect(() => {
    const now = Date.now();
    const soundShareKeys = keysKey ? keysKey.split('|') : [];
    setCurrent((prev) => decideScreenVolumeAdvice({ view: { kind: viewKind } as ScreenVolumeView, percent, soundShareKeys, now, state: prev.state }));
  }, [viewKind, percent, keysKey]);

  const answer = useCallback(() => {
    setCurrent((prev) => ({
      state: markScreenVolumeNoticeAnswered(prev.state),
      advice: { ...prev.advice, notice: null },
    }));
  }, []);

  return { advice: current.advice, answer };
}
