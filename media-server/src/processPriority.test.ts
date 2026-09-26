import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { it } from 'node:test';
import { BACKGROUND_PROCESS_PRIORITY, runAtBackgroundPriority } from './processPriority.js';

it('lowers a child process to background priority', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  try {
    assert.equal(runAtBackgroundPriority(child.pid), true);
    assert.equal(os.getPriority(child.pid!), BACKGROUND_PROCESS_PRIORITY);
  } finally {
    child.kill();
  }
});

it('ignores a missing process id', () => {
  assert.equal(runAtBackgroundPriority(undefined), false);
});
