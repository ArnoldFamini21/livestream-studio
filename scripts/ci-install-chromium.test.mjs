import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'ci-install-chromium.sh');

/** Runs the script with stand-ins for timeout and npx on PATH. */
function run({ withDeps = 0, browserOnly = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-chromium-'));
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls.log');
  const executable = (path, body) => {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };

  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(calls, '');
    executable(join(bin, 'timeout'), [
      '#!/bin/sh',
      'if [ "$1" = "-k" ]; then shift 2; fi',
      'echo "limit=$1" >> "$STUB_CALLS"',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'));
    executable(join(bin, 'npx'), [
      '#!/bin/sh',
      'echo "npx $*" >> "$STUB_CALLS"',
      'case "$*" in *--with-deps*) exit "$STUB_WITH_DEPS_STATUS" ;; esac',
      'exit "$STUB_BROWSER_ONLY_STATUS"',
      '',
    ].join('\n'));

    const result = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        STUB_CALLS: calls,
        STUB_WITH_DEPS_STATUS: String(withDeps),
        STUB_BROWSER_ONLY_STATUS: String(browserOnly),
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('installs Chromium with its system libraries under a time limit', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, ['limit=240', 'npx playwright-core install --with-deps chromium']);
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test('installs the browser alone when the system libraries cannot be installed in time', () => {
  // 124 is what `timeout` returns when it had to stop the command.
  const result = run({ withDeps: 124 });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    'limit=240',
    'npx playwright-core install --with-deps chromium',
    'npx playwright-core install chromium',
  ]);
  assert.match(result.stdout, /::warning::.*\(status 124\)/);
});

test('fails the step when the browser itself cannot be downloaded', () => {
  const result = run({ withDeps: 1, browserOnly: 7 });
  assert.equal(result.status, 7);
});
