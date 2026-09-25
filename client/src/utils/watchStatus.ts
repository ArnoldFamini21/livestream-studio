export interface WatchStatus {
  live: boolean;
  startedAt?: string;
  playlistPath?: string;
  viewers?: number;
}

/** Keep one request in flight, including while a sleeping server wakes up. */
export function pollWatchStatus(
  url: string,
  onStatus: (status: WatchStatus) => void,
  onError: () => void,
  options: { intervalMs?: number; timeoutMs?: number; fetcher?: typeof fetch } = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController;
  const poll = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const response = await (options.fetcher ?? fetch)(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Watch status unavailable');
      const status = await response.json() as WatchStatus;
      if (typeof status?.live !== 'boolean' || (status.live && (
        typeof status.playlistPath !== 'string' || !status.playlistPath.startsWith('/watch/')
      ))) throw new Error('Invalid watch status');
      if (!stopped) onStatus(status);
    } catch {
      if (!stopped) onError();
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(() => void poll(), options.intervalMs ?? 5_000);
    }
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
}
