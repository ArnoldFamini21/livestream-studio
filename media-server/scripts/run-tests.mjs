import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the media-server test suite in two passes.
 *
 * `sfuTransport.test.ts` exercises real loopback DTLS/SRTP through werift,
 * which leaves ICE sockets and DTLS timers open after the test's own teardown,
 * so that file cannot exit on its own and needs `--test-force-exit`.
 *
 * Applying that flag to the whole suite is what this split avoids: the forced
 * exit fires as soon as the runner believes it is done and cuts off test files
 * that are still executing, which the runner then reports as a *passing* run
 * with a lower test count. That silently skipped tests — under load it dropped
 * whole suites — while still exiting 0, so the suite could not be trusted in
 * CI. Keeping the flag scoped to the one file that needs it means no file can
 * truncate another.
 */

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FORCE_EXIT_TESTS = new Set(['sfuTransport.test.ts']);

const testFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

if (testFiles.length === 0) {
  console.error('No test files found in media-server/src');
  process.exit(1);
}

const selfContained = testFiles.filter((name) => !FORCE_EXIT_TESTS.has(name));
const needsForceExit = testFiles.filter((name) => FORCE_EXIT_TESTS.has(name));

function runPass(label, files, extraArgs) {
  return new Promise((resolve) => {
    if (files.length === 0) {
      resolve(0);
      return;
    }
    console.log(`\n# ${label} (${files.length} file${files.length === 1 ? '' : 's'})`);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', ...extraArgs, ...files.map((name) => path.join(testsDir, name))],
      { stdio: 'inherit' }
    );
    child.on('error', (err) => {
      console.error(`${label} failed to start: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        console.error(`${label} terminated by signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const selfContainedCode = await runPass('media-server tests', selfContained, []);
const forceExitCode = await runPass('media-server transport tests', needsForceExit, ['--test-force-exit']);

process.exit(selfContainedCode || forceExitCode);
