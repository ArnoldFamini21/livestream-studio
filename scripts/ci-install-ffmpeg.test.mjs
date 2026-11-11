import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'ci-install-ffmpeg.sh');

const WORKING_FFMPEG = '#!/bin/sh\necho "ffmpeg version 0-test"\n';
const BROKEN_FFMPEG = '#!/bin/sh\necho "error while loading shared libraries" >&2\nexit 127\n';

/**
 * Runs the script with stand-ins for sudo, timeout and apt-get on PATH, so the
 * outage paths (which real CI cannot produce on demand) are exercised too.
 */
function run({ update = 0, install = 0, installs = WORKING_FFMPEG, preinstalled = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-ffmpeg-'));
  const bin = join(dir, 'bin');
  const ffmpeg = join(dir, 'ffmpeg');
  const payload = join(dir, 'ffmpeg-payload');
  const calls = join(dir, 'calls.log');
  const githubEnv = join(dir, 'github-env');
  const executable = (path, body) => {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };

  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(githubEnv, '');
    writeFileSync(calls, '');
    executable(payload, installs);
    if (preinstalled) executable(ffmpeg, preinstalled);

    executable(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
    // timeout [-k N] SECONDS COMMAND...: record the limit, then run the command.
    executable(join(bin, 'timeout'), [
      '#!/bin/sh',
      'if [ "$1" = "-k" ]; then shift 2; fi',
      'echo "limit=$1" >> "$STUB_CALLS"',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'));
    executable(join(bin, 'apt-get'), [
      '#!/bin/sh',
      'action=""',
      'for arg in "$@"; do',
      '  case "$arg" in update|install) action="$arg" ;; esac',
      'done',
      'echo "apt-get $action" >> "$STUB_CALLS"',
      'if [ "$action" = "update" ]; then exit "$STUB_UPDATE_STATUS"; fi',
      'if [ "$STUB_INSTALL_STATUS" = "0" ]; then cp "$STUB_PAYLOAD" "$FFMPEG_SYSTEM_PATH"; chmod 755 "$FFMPEG_SYSTEM_PATH"; fi',
      'exit "$STUB_INSTALL_STATUS"',
      '',
    ].join('\n'));

    const result = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GITHUB_ENV: githubEnv,
        FFMPEG_SYSTEM_PATH: ffmpeg,
        STUB_CALLS: calls,
        STUB_PAYLOAD: payload,
        STUB_UPDATE_STATUS: String(update),
        STUB_INSTALL_STATUS: String(install),
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      exported: readFileSync(githubEnv, 'utf8'),
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
      ffmpeg,
      installed: existsSync(ffmpeg),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a working Ubuntu mirror exports the system FFmpeg to later steps', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.exported, `FFMPEG_BIN=${result.ffmpeg}\n`);
  assert.deepEqual(result.calls, ['limit=75', 'apt-get update', 'limit=180', 'apt-get install']);
  assert.match(result.stdout, /Using ffmpeg version 0-test/);
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test('an index refresh that times out skips the package install and leaves FFMPEG_BIN unset', () => {
  // 124 is what `timeout` returns when it had to stop the command.
  const result = run({ update: 124 });
  assert.equal(result.status, 0, 'the job continues: npm ci downloads FFmpeg from GitHub releases instead');
  assert.equal(result.exported, '');
  assert.deepEqual(result.calls, ['limit=75', 'apt-get update']);
  assert.match(result.stdout, /::warning::FFmpeg could not be installed from Ubuntu packages/);
  assert.match(result.stderr, /apt-get update did not finish \(status 124\)/);
});

test('a package install that fails or times out leaves FFMPEG_BIN unset', () => {
  for (const install of [100, 124]) {
    const result = run({ install });
    assert.equal(result.status, 0);
    assert.equal(result.exported, '');
    assert.equal(result.installed, false);
    assert.match(result.stderr, new RegExp(`apt-get install ffmpeg did not finish \\(status ${install}\\)`));
    assert.match(result.stdout, /::warning::/);
  }
});

test('a half-installed FFmpeg that cannot run is not exported', () => {
  const result = run({ installs: BROKEN_FFMPEG });
  assert.equal(result.status, 0);
  assert.equal(result.installed, true);
  assert.equal(result.exported, '');
  assert.match(result.stdout, /::warning::/);
});

test('an FFmpeg that is already on the runner is used without touching the network', () => {
  const result = run({ preinstalled: WORKING_FFMPEG, update: 124, install: 124 });
  assert.equal(result.status, 0);
  assert.equal(result.exported, `FFMPEG_BIN=${result.ffmpeg}\n`);
  assert.deepEqual(result.calls, []);
});
