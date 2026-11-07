/**
 * The media server only renders decks for admitted hosts and co-hosts, who
 * get a short-lived 'presentation-render' token from signaling (it is valid
 * for 10 minutes). One deck can need two render calls and several decks are
 * often added together, so the token is reused while it is fresh and
 * concurrent callers share one request.
 */

export const PRESENTATION_RENDER_TOKEN_REUSE_MS = 8 * 60 * 1000;

export interface CachedTokenSource {
  (): Promise<string | undefined>;
  clear(): void;
}

export function createCachedTokenSource(
  fetchToken: () => Promise<string>,
  options: { reuseMs?: number; now?: () => number } = {}
): CachedTokenSource {
  const reuseMs = options.reuseMs ?? PRESENTATION_RENDER_TOKEN_REUSE_MS;
  const now = options.now || Date.now;
  let cached: { token: string; fetchedAt: number } | null = null;
  let inFlight: Promise<string | undefined> | null = null;

  const source = (async () => {
    if (cached && now() - cached.fetchedAt < reuseMs) return cached.token;
    if (inFlight) return inFlight;
    inFlight = fetchToken()
      .then((token) => {
        cached = token ? { token, fetchedAt: now() } : null;
        return token || undefined;
      })
      // Without a token the request still goes out: a development media
      // server accepts it, and a production one answers with a clear 401.
      .catch(() => undefined)
      .finally(() => { inFlight = null; });
    return inFlight;
  }) as CachedTokenSource;
  source.clear = () => { cached = null; };
  return source;
}
