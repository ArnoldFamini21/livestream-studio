import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMediaActivity, readMediaActivity } from './media-activity.mjs';

// Real output of buildMediaRelayPrometheusMetrics (media-server/src/metrics.ts), trimmed.
const metricsText = (started, stopping = 0, idle = 0) => `# HELP livestream_studio_media_relay_sessions_total Active RTMP relay WebSocket sessions.
# TYPE livestream_studio_media_relay_sessions_total gauge
livestream_studio_media_relay_sessions_total ${started + stopping + idle}
# HELP livestream_studio_media_relay_sessions_by_state RTMP relay sessions by lifecycle state.
# TYPE livestream_studio_media_relay_sessions_by_state gauge
livestream_studio_media_relay_sessions_by_state{state="started"} ${started}
livestream_studio_media_relay_sessions_by_state{state="stopping"} ${stopping}
livestream_studio_media_relay_sessions_by_state{state="idle"} ${idle}
# HELP livestream_studio_media_destinations_total Configured RTMP destinations across active sessions.
# TYPE livestream_studio_media_destinations_total gauge
livestream_studio_media_destinations_total ${started * 2}
`;

const reply = (status, body = '') => async () => ({ status, ok: status >= 200 && status < 300, text: async () => body });
const noSleep = async () => {};

test('nothing started is idle, even with a connected studio that has not gone live', () => {
  assert.deepEqual(parseMediaActivity(metricsText(0)), { state: 'idle', started: 0, detail: '' });
  assert.equal(parseMediaActivity(metricsText(0, 0, 1)).state, 'idle');
});

test('one started session is busy', () => {
  const result = parseMediaActivity(metricsText(1));
  assert.equal(result.state, 'busy');
  assert.equal(result.started, 1);
});

test('a session that is stopping but still started stays busy', () => {
  assert.equal(parseMediaActivity(metricsText(1, 1)).state, 'busy');
});

test('stopping or idle counts alone never make the server busy', () => {
  assert.equal(parseMediaActivity(metricsText(0, 3, 2)).state, 'idle');
});

test('a missing metric is unknown', () => {
  const text = '# TYPE livestream_studio_media_relay_sessions_total gauge\nlivestream_studio_media_relay_sessions_total 2\n';
  const result = parseMediaActivity(text);
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /missing/);
});

test('garbage, an HTML page and empty text are unknown', () => {
  assert.equal(parseMediaActivity('<html><body>Service Unavailable</body></html>').state, 'unknown');
  assert.equal(parseMediaActivity('\u0000\u0001 not metrics ~~').state, 'unknown');
  assert.equal(parseMediaActivity('').state, 'unknown');
  assert.equal(parseMediaActivity(undefined).state, 'unknown');
});

test('a started count that is not a number is unknown', () => {
  const text = 'livestream_studio_media_relay_sessions_by_state{state="started"} NaN\n';
  assert.equal(parseMediaActivity(text).state, 'unknown');
  assert.equal(parseMediaActivity('livestream_studio_media_relay_sessions_by_state{state="started"} -1\n').state, 'unknown');
});

test('label order, spacing and a timestamp do not matter', () => {
  const text = 'livestream_studio_media_relay_sessions_by_state{instance="a", state="started"} 2 1731000000000\r\n';
  const result = parseMediaActivity(text);
  assert.equal(result.state, 'busy');
  assert.equal(result.started, 2);
});

test('readMediaActivity reports idle and busy from the fetched text', async () => {
  assert.equal((await readMediaActivity({ fetchImpl: reply(200, metricsText(0)) })).state, 'idle');
  assert.equal((await readMediaActivity({ fetchImpl: reply(200, metricsText(1)) })).state, 'busy');
});

test('an HTTP 404 is unknown and is not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 404, ok: false, text: async () => 'not found' }; };
  const result = await readMediaActivity({ fetchImpl, sleep: noSleep });
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /HTTP 404/);
  assert.equal(calls, 1);
});

test('a waking server (503, 503, then 200) is retried and answers', async () => {
  const answers = [503, 502, 200];
  const sleeps = [];
  const fetchImpl = async () => {
    const status = answers.shift();
    return { status, ok: status === 200, text: async () => (status === 200 ? metricsText(1) : 'waking') };
  };
  const result = await readMediaActivity({ fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, retryDelayMs: 7 });
  assert.equal(result.state, 'busy');
  assert.deepEqual(sleeps, [7, 7]);
});

test('an HTTP error on every attempt is unreachable', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 500, ok: false, text: async () => 'boom' }; };
  const result = await readMediaActivity({ fetchImpl, sleep: noSleep, attempts: 3 });
  assert.equal(result.state, 'unreachable');
  assert.match(result.detail, /HTTP 500.*3 attempts/);
  assert.equal(calls, 3);
});

test('a network error on every attempt is unreachable', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const result = await readMediaActivity({ fetchImpl, sleep: noSleep });
  assert.equal(result.state, 'unreachable');
  assert.match(result.detail, /fetch failed/);
});

test('a request that never answers times out (fake timers) and is unreachable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = 0;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
  });
  const pending = readMediaActivity({ fetchImpl, timeoutMs: 1000, attempts: 2, retryDelayMs: 500 });
  // attempt 1 times out, then the retry delay, then attempt 2 times out
  for (const step of [1000, 500, 1000]) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(step);
  }
  const result = await pending;
  assert.equal(result.state, 'unreachable');
  assert.match(result.detail, /no answer within 1 s/);
  assert.equal(aborted, 2);
});
