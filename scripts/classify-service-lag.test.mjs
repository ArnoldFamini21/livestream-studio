import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { classifyProductionChanges } from './classify-production-changes.mjs';
import {
  classifyServiceRange,
  MEDIA_HEALTH_HEADERS,
  mergeServiceClassifications,
  parseHealthCommit,
  readServiceCommit,
  resolveCommitInHistory,
} from './classify-service-lag.mjs';

const FULL = '8a20ff7571e528de7175bf4f1f46eae13ca08dbd';
const HEAD = 'a'.repeat(40);
const noSleep = async () => {};
const json = (status, body) => async () => ({ status, json: async () => body });

test('parseHealthCommit accepts 7 to 40 hex characters and nothing else', () => {
  assert.equal(parseHealthCommit({ commit: FULL }), FULL);
  assert.equal(parseHealthCommit({ commit: '8A20FF7' }), '8a20ff7');
  assert.equal(parseHealthCommit({ commit: '8a20ff' }), null); // 6 characters
  assert.equal(parseHealthCommit({ commit: `${FULL}0` }), null); // 41 characters
  assert.equal(parseHealthCommit({ commit: 'main' }), null);
  assert.equal(parseHealthCommit({ commit: '8a20ff7; rm -rf /' }), null);
  assert.equal(parseHealthCommit({ commit: '$(touch x)abcdef' }), null);
  assert.equal(parseHealthCommit({ commit: '--output=x1234567' }), null);
  assert.equal(parseHealthCommit({ commit: 123456789 }), null);
  assert.equal(parseHealthCommit({}), null);
  assert.equal(parseHealthCommit(null), null);
  assert.equal(parseHealthCommit('text'), null);
});

test('resolveCommitInHistory runs git only for hex strings and needs an ancestor', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return `${FULL}\n`;
    return '';
  };
  assert.equal(resolveCommitInHistory('8a20ff7', HEAD, run), FULL);
  assert.deepEqual(calls[1], ['merge-base', '--is-ancestor', FULL, HEAD]);

  calls.length = 0;
  assert.equal(resolveCommitInHistory('8a20ff7; echo hi', HEAD, run), null);
  assert.equal(resolveCommitInHistory('--help', HEAD, run), null);
  assert.equal(resolveCommitInHistory('', HEAD, run), null);
  assert.equal(calls.length, 0);
});

test('resolveCommitInHistory returns null for an unknown commit or one outside the history', () => {
  const unknown = () => { throw new Error('unknown revision'); };
  assert.equal(resolveCommitInHistory('1234567', HEAD, unknown), null);
  const notAncestor = (args) => {
    if (args[0] === 'merge-base') throw new Error('exit 1');
    return `${FULL}\n`;
  };
  assert.equal(resolveCommitInHistory('8a20ff7', HEAD, notAncestor), null);
});

test('resolveCommitInHistory against real git: this repository HEAD resolves, a made-up id does not', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(resolveCommitInHistory(head.slice(0, 10), head), head);
  assert.equal(resolveCommitInHistory('1234567890abcdef1234567890abcdef12345678', head), null);
});

test('readServiceCommit sends the headers and returns the commit', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers };
    return { status: 200, json: async () => ({ status: 'ok', commit: FULL }) };
  };
  const result = await readServiceCommit({ url: 'https://example.test/health', headers: MEDIA_HEALTH_HEADERS, fetchImpl, sleep: noSleep });
  assert.deepEqual(result, { commit: FULL });
  assert.equal(seen.headers.Origin, 'https://studio.arnoldfamini.com');
});

test('readServiceCommit falls back (no commit) on HTTP 403, a bad body, and network errors', async () => {
  assert.equal((await readServiceCommit({ url: 'u', fetchImpl: json(403, {}), sleep: noSleep })).commit, null);
  assert.match((await readServiceCommit({ url: 'u', fetchImpl: json(200, { status: 'ok' }), sleep: noSleep })).reason, /no usable commit/);
  const broken = async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  assert.equal((await readServiceCommit({ url: 'u', fetchImpl: broken, sleep: noSleep })).commit, null);
  const down = async () => { throw new TypeError('fetch failed'); };
  const result = await readServiceCommit({ url: 'u', fetchImpl: down, sleep: noSleep, attempts: 2 });
  assert.equal(result.commit, null);
  assert.match(result.reason, /fetch failed.*2 attempts/);
});

test('readServiceCommit retries a waking service', async () => {
  const statuses = [503, 200];
  const fetchImpl = async () => {
    const status = statuses.shift();
    return { status, json: async () => ({ commit: FULL }) };
  };
  assert.deepEqual(await readServiceCommit({ url: 'u', fetchImpl, sleep: noSleep }), { commit: FULL });
});

function range({ commit = FULL, base = FULL, files = [], logs = [] } = {}) {
  return classifyServiceRange({
    name: 'media',
    url: 'u',
    headers: {},
    head: HEAD,
    readCommit: async () => (commit ? { commit } : { commit: null, reason: 'HTTP 403' }),
    resolve: () => base,
    listFiles: () => files,
    log: (line) => logs.push(line),
  });
}

test('a service behind main gets its own catch-up classification', async () => {
  const result = await range({ files: ['media-server/src/index.ts', 'client/src/App.tsx'] });
  assert.equal(result.mediaChanged, true);
  assert.equal(result.signalingChanged, false);
});

test('a service whose files did not change in the range is not behind', async () => {
  const result = await range({ files: ['client/src/App.tsx', 'docs/x.md', '.github/workflows/deploy.yml'] });
  assert.equal(result.mediaChanged, false);
  assert.equal(result.signalingChanged, false);
});

test('an unreadable commit, or one outside the history, falls back to null with a warning', async () => {
  const logs = [];
  assert.equal(await range({ commit: null, logs }), null);
  assert.equal(await range({ base: null, logs }), null);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => line.startsWith('::warning::')));
});

test('a failing diff falls back to null', async () => {
  const result = await classifyServiceRange({
    name: 'media', url: 'u', headers: {}, head: HEAD,
    readCommit: async () => ({ commit: FULL }), resolve: () => FULL,
    listFiles: () => { throw new Error('bad object'); }, log: () => {},
  });
  assert.equal(result, null);
});

test('merge: the push alone decides when no range is known (today behavior)', () => {
  const push = classifyProductionChanges(['server/src/a.ts']);
  const merged = mergeServiceClassifications(push, null, null);
  assert.equal(merged.signalingChanged, true);
  assert.equal(merged.mediaChanged, false);
  assert.deepEqual(merged.signalingFiles, ['server/src/a.ts']);
});

test('merge: a held media change is redeployed by a later unrelated push', () => {
  const push = classifyProductionChanges(['client/src/App.tsx']);
  const mediaRange = classifyProductionChanges(['media-server/src/index.ts', 'client/src/App.tsx']);
  const merged = mergeServiceClassifications(push, null, mediaRange);
  assert.equal(merged.mediaChanged, true);
  assert.equal(merged.signalingChanged, false);
  assert.deepEqual(merged.mediaFiles, ['media-server/src/index.ts']);
});

test('merge: a service that is current is never redeployed because of the other service range', () => {
  const push = classifyProductionChanges(['client/src/App.tsx']);
  // Signaling is behind (server file); media range must not leak into signaling or the reverse.
  const signalingRange = classifyProductionChanges(['server/src/a.ts']);
  const mediaRange = classifyProductionChanges(['client/src/App.tsx']);
  const merged = mergeServiceClassifications(push, signalingRange, mediaRange);
  assert.equal(merged.signalingChanged, true);
  assert.equal(merged.mediaChanged, false);
});

test('merge: shared files in the push and in the range are listed once', () => {
  const push = classifyProductionChanges(['shared/src/index.ts']);
  const range = classifyProductionChanges(['shared/src/index.ts', 'media-server/src/x.ts']);
  const merged = mergeServiceClassifications(push, range, range);
  assert.deepEqual(merged.signalingFiles, ['shared/src/index.ts']);
  assert.deepEqual(merged.mediaFiles, ['shared/src/index.ts', 'media-server/src/x.ts']);
});
