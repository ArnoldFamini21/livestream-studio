/**
 * Watch links used to be /watch/<roomId> (10-character ids). They now use a
 * private watch id; a link of the old shape that the server no longer
 * resolves was replaced, which is worth saying instead of "not found".
 */
export function looksLikeReplacedWatchLink(id: string): boolean {
  return /^[A-Za-z0-9_-]{10}$/.test(id);
}

/** Where the address bar should point once the server named the canonical watch id. */
export function canonicalWatchPath(requestedId: string, canonicalId: string | undefined, pathname: string): string | null {
  if (!canonicalId || canonicalId === requestedId) return null;
  const prefix = `/watch/${encodeURIComponent(requestedId)}`;
  if (!pathname.startsWith(prefix)) return null;
  return `/watch/${encodeURIComponent(canonicalId)}${pathname.slice(prefix.length)}`;
}

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
