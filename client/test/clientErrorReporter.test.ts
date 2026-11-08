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
    release: 'abc1234',
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
    assert.equal(sent[0].message, 'TypeError: details omitted');
    assert.equal(sent[0].page, '/studio/:roomId');
    assert.equal(sent[0].release, 'abc1234');
    assert.equal(sent[0].count, 1);
    assert.equal(sent[0].stack, undefined, 'local file paths are not transmitted');
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
    reporter.report('error', 'Failed to fetch');
    reporter.report('error', 'NotAllowedError');
    assert.equal(reporter.report('error', 'QuotaExceededError'), false);
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
    assert.deepEqual(describeClientError({ code: 7 }), { message: 'Error: details omitted' });
    assert.equal(describeClientError(null), null);
  });

  it('groups by sanitized message and stack, keeping distinct source locations separate', () => {
    const { reporter, sent } = setup();
    const error = new TypeError('Cannot read properties of undefined (reading "John Smith")');
    error.stack = 'TypeError: John Smith\n at privateName (https://studio.test/assets/StudioRoom-ABCdef12.js:10:20)';
    reporter.report('error', error);
    reporter.report('error', error);
    error.stack = 'TypeError: Jane Jones\n at otherName (https://studio.test/assets/StudioRoom-ABCdef12.js:11:20)';
    reporter.report('error', error);
    reporter.flush();
    assert.deepEqual(sent.map((report) => report.count), [1, 1, 1]);
    assert.equal(sent[0].stack, 'asset:ABCdef12:10:20');
    assert.equal(sent[1].stack, 'asset:ABCdef12:11:20');
    assert.doesNotMatch(JSON.stringify(sent), /John|Jane|Smith|Jones|studio\.test|privateName|otherName/);
  });

  it('removes private data before calling the transport', () => {
    const sent: ClientErrorPayload[] = [];
    const reporter = createClientErrorReporter({ send: (report) => sent.push(report), getPage: () => '/watch/private-room?email=alice@example.com', release: 'alice@example.com' });
    reporter.report('recording', 'Recording for Alice Smith +63 917 123 4567 /Users/Alice/private.mp4 failed. token=private-secret');
    reporter.report('error', { email: 'alice@example.com', token: 'private-secret' });
    assert.equal(sent[0].message, 'Error: details omitted');
    assert.equal(sent[0].page, '/watch/:roomId');
    assert.equal(sent[0].release, undefined);
    assert.doesNotMatch(JSON.stringify(sent), /Alice|alice|private|917|Users|mp4/);
  });
});
