import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createClientErrorReporter,
  describeClientError,
  isIgnoredClientError,
  type ClientErrorPayload,
} from '../src/utils/clientErrorReporter.ts';

function setup(overrides: { maxReports?: number } = {}) {
  let time = 0;
  const sent: ClientErrorPayload[] = [];
  const reporter = createClientErrorReporter({
    send: (payload) => sent.push(payload),
    release: 'abc123',
    getPage: () => '/studio/room-1',
    now: () => time,
    dedupeWindowMs: 1000,
    ...overrides,
  });
  return { reporter, sent, advance: (ms: number) => { time += ms; } };
}

describe('client error reporter', () => {
  it('sends the first occurrence with page and release', () => {
    const { reporter, sent } = setup();
    assert.equal(reporter.report('stream', new TypeError('relay closed')), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'stream');
    assert.equal(sent[0].message, 'TypeError: relay closed');
    assert.equal(sent[0].page, '/studio/room-1');
    assert.equal(sent[0].release, 'abc123');
    assert.equal(sent[0].count, 1);
    assert.ok(sent[0].stack);
  });

  it('folds repeats into one counted report', () => {
    const { reporter, sent, advance } = setup();
    reporter.report('error', 'boom');
    reporter.report('error', 'boom');
    reporter.report('error', 'boom');
    assert.equal(sent.length, 1);
    reporter.flush();
    assert.deepEqual(sent.map((payload) => payload.count), [1, 2]);
    reporter.flush();
    assert.equal(sent.length, 2);
    advance(1500);
    reporter.report('error', 'boom');
    assert.equal(sent.length, 3);
    assert.equal(sent[2].count, 1);
  });

  it('sends repeats waiting in the window when the same error recurs later', () => {
    const { reporter, sent, advance } = setup();
    reporter.report('media', 'camera lost');
    reporter.report('media', 'camera lost');
    advance(1500);
    reporter.report('media', 'camera lost');
    assert.deepEqual(sent.map((payload) => payload.count), [1, 1, 1]);
  });

  it('stops at the per-page budget', () => {
    const { reporter, sent } = setup({ maxReports: 2 });
    reporter.report('error', 'a');
    reporter.report('error', 'b');
    assert.equal(reporter.report('error', 'c'), false);
    assert.equal(sent.length, 2);
  });

  it('ignores browser noise and extension errors', () => {
    assert.equal(isIgnoredClientError('ResizeObserver loop completed with undelivered notifications.'), true);
    assert.equal(isIgnoredClientError('Script error.'), true);
    assert.equal(isIgnoredClientError('boom', 'at chrome-extension://abc/content.js:1'), true);
    assert.equal(isIgnoredClientError('boom', 'at https://studio.test/app.js:1'), false);
    const { reporter, sent } = setup();
    assert.equal(reporter.report('error', 'Script error.'), false);
    assert.equal(reporter.report('unhandledrejection', undefined), false);
    assert.equal(sent.length, 0);
  });

  it('never throws when sending fails', () => {
    const reporter = createClientErrorReporter({ send: () => { throw new Error('offline'); } });
    assert.doesNotThrow(() => reporter.report('error', 'boom'));
  });

  it('describes non-Error rejections', () => {
    assert.deepEqual(describeClientError('text'), { message: 'text' });
    assert.deepEqual(describeClientError({ message: 'obj' }), { message: 'obj' });
    assert.deepEqual(describeClientError({ code: 7 }), { message: '{"code":7}' });
    assert.equal(describeClientError(null), null);
  });
});
