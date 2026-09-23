import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildProductionReadiness,
  getStrictStartupFailure,
} from '../dist/services/productionReadiness.js';
import {
  getClientErrorCounts,
  parseClientErrorReport,
  recordClientError,
  redactUrls,
  resetClientErrorCounts,
} from '../dist/services/clientErrors.js';
import { buildSignalingPrometheusMetrics } from '../dist/services/metrics.js';

const READY_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://studio@db/studio',
  LIVE_STREAM_TOKEN_SECRET: 'x'.repeat(32),
  CLIENT_URL: 'https://studio.example.test',
  YOUTUBE_API_KEY: 'key',
};

describe('production readiness', () => {
  it('is ready when database, token secret, and TURN are configured', () => {
    const readiness = buildProductionReadiness(READY_ENV, { turnReady: true });
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.issues, []);
  });

  it('names each blocking gap', () => {
    const readiness = buildProductionReadiness({ NODE_ENV: 'production' }, { turnReady: false });
    assert.equal(readiness.ready, false);
    const blocking = readiness.issues.filter((issue) => issue.severity === 'blocking').map((issue) => issue.id);
    assert.deepEqual(blocking, ['database-missing', 'token-secret-missing', 'turn-missing']);
    assert.ok(readiness.issues.some((issue) => issue.id === 'client-url-missing' && issue.severity === 'warning'));
  });

  it('reports stores that fell back to memory even when a database URL is set', () => {
    const readiness = buildProductionReadiness(READY_ENV, { turnReady: true }, { persistenceFallbacks: ['room snapshot'] });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.issues[0].id, 'database-fallback-room-snapshot');
  });

  it('fails startup only in strict production mode', () => {
    const env = { NODE_ENV: 'production', PRODUCTION_STRICT: 'true' };
    const failure = getStrictStartupFailure(buildProductionReadiness(env, { turnReady: true }));
    assert.match(failure, /PRODUCTION_STRICT/);
    assert.match(failure, /DATABASE_URL/);
    assert.equal(getStrictStartupFailure(buildProductionReadiness({ NODE_ENV: 'production' }, { turnReady: false })), null);
    assert.equal(getStrictStartupFailure(buildProductionReadiness({ PRODUCTION_STRICT: '1' }, { turnReady: false })), null);
    assert.equal(getStrictStartupFailure(buildProductionReadiness({ ...READY_ENV, PRODUCTION_STRICT: '1' }, { turnReady: true })), null);
  });
});

describe('client error reports', () => {
  it('strips query strings and fragments that can carry tokens', () => {
    assert.equal(
      redactUrls('at https://studio.example.test/join/abc?token=secret#frag (app.js:1)'),
      'at https://studio.example.test/join/abc (app.js:1)'
    );
  });

  it('parses, truncates, and redacts a report', () => {
    const report = parseClientErrorReport({
      kind: 'stream',
      message: `Relay failed for https://media.test/ws?token=abc ${'x'.repeat(600)}`,
      stack: 'Error\n  at https://studio.test/assets/app.js?v=1:10:4',
      page: 'https://studio.test/studio/room?invite=secret',
      release: 'abc123',
      count: 5000,
    }, 'Mozilla/5.0');
    assert.equal(report.kind, 'stream');
    assert.equal(report.message.length <= 500, true);
    assert.doesNotMatch(report.message, /token=/);
    assert.equal(report.stack, 'Error\n  at https://studio.test/assets/app.js');
    assert.equal(report.page, 'https://studio.test/studio/room');
    assert.equal(report.count, 1000);
    assert.equal(report.userAgent, 'Mozilla/5.0');
  });

  it('rejects empty reports and defaults unknown kinds', () => {
    assert.equal(parseClientErrorReport(null), null);
    assert.equal(parseClientErrorReport({ message: '   ' }), null);
    assert.equal(parseClientErrorReport({ kind: 'nope', message: 'boom' }).kind, 'error');
  });

  it('counts reports by kind in the Prometheus output', () => {
    resetClientErrorCounts();
    const lines = [];
    recordClientError(parseClientErrorReport({ kind: 'media', message: 'camera lost', count: 3 }), (line) => lines.push(line));
    assert.equal(getClientErrorCounts().media, 3);
    assert.equal(JSON.parse(lines[0]).event, 'client_error');
    assert.match(buildSignalingPrometheusMetrics(new Map()), /livestream_studio_client_errors_total\{kind="media"\} 3/);
    resetClientErrorCounts();
  });
});
