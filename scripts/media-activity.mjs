// Is anything on the air? Reads the media server's /metrics text and answers
// with one of: idle, busy, unknown (cannot tell), or unreachable (no answer).
//
// The line that matters is
//   livestream_studio_media_relay_sessions_by_state{state="started"} N
// built by buildMediaRelayPrometheusMetrics (media-server/src/metrics.ts). A
// session counts as "started" from the moment the studio starts a relay (a real
// broadcast OR a private test; the metric does not tell them apart) until the
// session is removed. That includes:
//   - a real broadcast, from the start request, even before a destination is live;
//   - a broadcast held on the "reconnecting" slate after the studio dropped: the
//     session stays in the list, still started, for up to 3 minutes, so a
//     deploy that would end it is held too;
//   - a private test: counted exactly like a broadcast;
//   - a session that is shutting down, until it leaves the list.
// A studio that is connected but has not pressed Go Live is counted as idle.

export const MEDIA_METRICS_URL = 'https://livestream-studio-media-server.onrender.com/metrics';
export const STARTED_METRIC = 'livestream_studio_media_relay_sessions_by_state';

const SAMPLE_LINE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)(?:\s+-?\d+)?\s*$/;

/**
 * Parses Prometheus text. Returns { state, started, detail } where state is
 * 'busy' (started > 0), 'idle' (started == 0) or 'unknown' (metric missing or
 * the text cannot be read).
 */
export function parseMediaActivity(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { state: 'unknown', started: null, detail: 'the metrics text is empty' };
  }

  let started = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = SAMPLE_LINE.exec(line);
    if (!match || match[1] !== STARTED_METRIC) continue;
    if (!/(^|,)\s*state\s*=\s*"started"\s*(,|$)/.test(match[2] || '')) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value) || value < 0) {
      return { state: 'unknown', started: null, detail: `the started count is not a number (${match[3]})` };
    }
    // Two lines for the same state should never happen; if they do, trust the larger one.
    started = started === null ? value : Math.max(started, value);
  }

  if (started === null) {
    return { state: 'unknown', started: null, detail: `the metric ${STARTED_METRIC}{state="started"} is missing` };
  }
  return { state: started > 0 ? 'busy' : 'idle', started, detail: '' };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { 'cache-control': 'no-cache' } });
    const status = Number(response.status);
    const text = await response.text();
    return { status, text };
  })();
  // If the timeout wins, the aborted request rejects later; nobody is waiting for it.
  request.catch(() => {});
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the media server what it is doing. A sleeping Render service needs about
 * a minute to answer, so a network error, a timeout or a 5xx/429 answer is
 * retried (attempts times, retryDelayMs apart). Result:
 *   { state: 'idle' | 'busy' | 'unknown' | 'unreachable', started, detail }
 * 'unreachable' means every attempt failed; 'unknown' means the server answered
 * but the answer says nothing usable (a 4xx, a missing metric, garbage).
 */
export async function readMediaActivity({
  fetchImpl = globalThis.fetch,
  url = MEDIA_METRICS_URL,
  timeoutMs = 45_000,
  attempts = 3,
  retryDelayMs = 5_000,
  sleep = defaultSleep,
} = {}) {
  let lastDetail = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { status, text } = await fetchOnce(fetchImpl, url, timeoutMs);
      if (status >= 200 && status < 300) {
        return parseMediaActivity(text);
      }
      if (status < 500 && status !== 429) {
        return { state: 'unknown', started: null, detail: `the media server answered HTTP ${status}` };
      }
      lastDetail = `the media server answered HTTP ${status}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { state: 'unreachable', started: null, detail: `${lastDetail} (after ${attempts} attempts)` };
}
