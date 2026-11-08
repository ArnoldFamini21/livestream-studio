import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientErrorTracker, parseClientErrorReport } from '../dist/services/clientErrors.js';

function fixture(options = {}) {
  let time = 1_000;
  const lines = [];
  const tracker = createClientErrorTracker({ now: () => time, log: (line) => lines.push(JSON.parse(line)), ...options });
  return { tracker, lines, advance: (ms) => { time += ms; } };
}
const report = (overrides = {}) => ({ kind: 'error', message: 'TypeError: Cannot read properties of undefined (reading "private")', stack: 'at privateName (https://studio.test/assets/StudioRoom-ABcd1234.js:10:20)', release: 'abc1234', count: 1, ...overrides });

test('same message and stack aggregate per release; distinct stack remains separate', () => {
  const { tracker, lines, advance } = fixture();
  tracker.record(report());
  tracker.record(report({ count: 3, page: '/studio/another-room' }));
  assert.equal(lines.length, 1);
  advance(60_000);
  tracker.flush();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].count, 3);
  assert.equal(lines[1].total, 4);
  assert.equal(lines[1].fingerprint, lines[0].fingerprint);
  tracker.record(report({ release: 'fed4321' }));
  assert.equal(lines[2].fingerprint, lines[0].fingerprint);
  assert.equal(lines[2].total, 1);
  tracker.record(report({ stack: 'asset:ABcd1234:11:20' }));
  assert.notEqual(lines[3].fingerprint, lines[0].fingerprint);
  tracker.record(report({ message: 'Network request failed' }));
  assert.notEqual(lines[4].fingerprint, lines[0].fingerprint);
  tracker.flush();
  assert.equal(lines.length, 5, 'empty flushes do not duplicate counts');
  assert.equal(tracker.counts().error, 7);
});

test('intake and logs discard arbitrary user data even when the browser bypasses sanitization', () => {
  const { tracker, lines } = fixture();
  tracker.record(report({ message: 'Alice Smith +63 917 123 4567 token=private-secret', page: 'https://host/watch/private-room?email=alice@example.com', release: 'alice@example.com', userAgent: 'Private device name', ip: '1.2.3.4', count: 50000 }));
  assert.equal(lines[0].message, 'Error: details omitted');
  assert.equal(lines[0].page, '/watch/:roomId');
  assert.equal(lines[0].count, 1000);
  assert.doesNotMatch(JSON.stringify(lines), /Alice|Smith|917|private|alice|host|userAgent|1\.2\.3\.4|Private/);
  assert.equal(parseClientErrorReport([]), null);
  assert.equal(parseClientErrorReport({ message: '   ' }), null);
  assert.equal(parseClientErrorReport({ message: 'boom', count: Infinity }).count, 1);
});

test('group storage expires and evicts at a fixed bound', () => {
  const { tracker, lines, advance } = fixture({ maxGroups: 2, retentionMs: 1000 });
  tracker.record(report({ stack: 'asset:ABcd1234:1:1' }));
  tracker.record(report({ stack: 'asset:ABcd1234:2:1' }));
  tracker.record(report({ stack: 'asset:ABcd1234:1:1' }));
  tracker.record(report({ stack: 'asset:ABcd1234:3:1' }));
  assert.equal(tracker.groupCount(), 2);
  advance(1000);
  tracker.flush();
  assert.equal(tracker.groupCount(), 0);
  assert.equal(lines.reduce((sum, line) => sum + line.count, 0), 4);
});

test('global logging budget bounds distinct-error floods while metrics still count errors', () => {
  const { tracker, lines, advance } = fixture({ maxGroups: 3, maxLogsPerMinute: 2 });
  for (let i = 0; i < 100; i++) tracker.record(report({ stack: `asset:ABcd1234:${i}:1` }));
  assert.equal(lines.length, 2);
  assert.equal(tracker.groupCount(), 3);
  assert.equal(tracker.counts().error, 100);
  advance(60_000);
  tracker.flush();
  assert.equal(lines.length, 4);
  assert.equal(tracker.counts().error, 100);
});

test('unavailable log sink cannot crash the application', () => {
  const tracker = createClientErrorTracker({ log: () => { throw new Error('sink unavailable'); } });
  assert.doesNotThrow(() => { tracker.record(report()); tracker.flush(); });
  assert.equal(tracker.counts().error, 1);
});
