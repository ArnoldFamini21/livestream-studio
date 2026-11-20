import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultViewerChatSwitches,
  effectiveViewerPollMs,
  type ViewerChatSwitches,
  type ViewerReactionType,
  type WatchChatMessage,
  type WatchLiveResponse,
} from '@studio/shared';
import { requestJson } from '../utils/apiClient.ts';
import {
  applyLiveResponse,
  emptyChatView,
  liveQuery,
  reactionsToFloat,
  type WatchChatView,
} from '../utils/watchViewerChat.ts';

interface UseWatchLiveOptions {
  watchId: string;
  /** Reactions from other viewers and the host's side, ready to float (already without this viewer's own taps). */
  onReactions: (types: ViewerReactionType[]) => void;
}

export interface WatchLive {
  switches: ViewerChatSwitches;
  messages: WatchChatMessage[];
  captionsAvailable: boolean;
  /** Asks for an up-to-date moderated feed after this viewer sends a message. */
  refresh: () => void;
  /** Remembers a reaction this viewer floated at once, so the next answer does not float it again. */
  noteOwnReaction: (type: ViewerReactionType) => void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Asks the server what changed (chat, reactions, the three switches) every few
 * seconds in one small request. The server says how often it would like to be
 * asked, and a hidden tab asks much less often. Nothing here is a WebSocket.
 */
export function useWatchLive({ watchId, onReactions }: UseWatchLiveOptions): WatchLive {
  const [switches, setSwitches] = useState<ViewerChatSwitches>(defaultViewerChatSwitches);
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [view, setView] = useState<WatchChatView>(emptyChatView);
  const viewRef = useRef(view);
  const onReactionsRef = useRef(onReactions);
  onReactionsRef.current = onReactions;
  const ownReactionsRef = useRef<Partial<Record<ViewerReactionType, number>>>({});
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    let hintMs: number | undefined;
    let queuedRefresh = false;
    const path = `/api/watch/${encodeURIComponent(watchId)}/live`;

    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void ask(), delay);
    };

    const ask = async () => {
      if (stopped || controller) return;
      queuedRefresh = false;
      controller = new AbortController();
      try {
        const answer = await requestJson<WatchLiveResponse>(`${path}${liveQuery(viewRef.current)}`, { timeoutMs: 8_000, signal: controller.signal });
        if (stopped) return;
        failures = 0;
        hintMs = answer.pollMs;
        setCaptionsAvailable(answer.captionsAvailable === true);
        setSwitches((current) => (
          current.chat === answer.switches.chat && current.reactions === answer.switches.reactions && current.questions === answer.switches.questions
            ? current
            : { chat: answer.switches.chat, reactions: answer.switches.reactions, questions: answer.switches.questions }
        ));
        const next = applyLiveResponse(viewRef.current, answer);
        if (next !== viewRef.current) {
          viewRef.current = next;
          setView(next);
        }
        if (!answer.switches.reactions || answer.reset) {
          ownReactionsRef.current = {};
        } else {
          const { floats, ownLeft } = reactionsToFloat(answer.reactions ?? {}, ownReactionsRef.current);
          ownReactionsRef.current = ownLeft;
          if (floats.length > 0) onReactionsRef.current(floats);
        }
      } catch {
        if (stopped) return;
        // Keep what is on screen and try again, a little slower each time.
        failures += 1;
      }
      controller = undefined;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const base = effectiveViewerPollMs(hintMs, hidden);
      const delay = failures > 0 ? Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(failures, 3)) : base;
      schedule(queuedRefresh && failures === 0 ? 0 : delay);
    };

    refreshRef.current = () => {
      if (controller) queuedRefresh = true;
      else schedule(0);
    };
    // Coming back to the tab: ask at once instead of waiting out the slow wait.
    const onVisibility = () => {
      if (!document.hidden && !controller) schedule(0);
    };
    document.addEventListener('visibilitychange', onVisibility);
    void ask();
    return () => {
      stopped = true;
      refreshRef.current = null;
      controller?.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [watchId]);

  const refresh = useCallback(() => refreshRef.current?.(), []);

  const noteOwnReaction = useCallback((type: ViewerReactionType) => {
    ownReactionsRef.current = { ...ownReactionsRef.current, [type]: (ownReactionsRef.current[type] ?? 0) + 1 };
  }, []);

  return { switches, messages: view.messages, captionsAvailable, refresh, noteOwnReaction };
}
