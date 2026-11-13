// Pins the deploy safety properties of .github/workflows/deploy.yml that a later
// edit must not remove silently. The workflow is read as text (no YAML library).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const HOLD = 'Hold the deploy while a broadcast is on the air';

// Splits the steps list into { name, text, start }.
function steps() {
  const marker = /^ {6}- name: (.+)$/gm;
  const found = [];
  let match;
  while ((match = marker.exec(workflow))) found.push({ name: match[1].trim(), start: match.index });
  return found.map((step, index) => ({
    ...step,
    text: workflow.slice(step.start, index + 1 < found.length ? found[index + 1].start : workflow.length),
  }));
}

const all = steps();
const find = (name) => all.find((step) => step.name === name);
const indexOf = (name) => all.findIndex((step) => step.name === name);

test('the hold step exists exactly once and runs the wait command', () => {
  assert.equal(all.filter((step) => step.name === HOLD).length, 1);
  assert.match(find(HOLD).text, /run: node scripts\/wait-for-idle-media\.mjs\s*$/m);
});

test('the hold comes before the Render trigger and before the client is published', () => {
  const hold = indexOf(HOLD);
  assert.ok(hold >= 0);
  for (const later of ['Trigger Render deploys', 'Deploy to deploy branch', 'Verify static client cache', 'Verify production services']) {
    assert.ok(indexOf(later) > hold, `${later} must come after the hold`);
  }
  // Nothing before the hold may trigger a deploy hook or publish the client.
  const before = workflow.slice(0, find(HOLD).start);
  assert.doesNotMatch(before, /peaceiris\/actions-gh-pages/);
  assert.doesNotMatch(before, /DEPLOY_HOOK_URL/);
  assert.doesNotMatch(before, /curl /);
});

test('the hold cannot fail softly: it is not continue-on-error', () => {
  assert.doesNotMatch(find(HOLD).text, /continue-on-error/);
});

test('a push can never skip the hold; only a manual run with deploy_while_live can', () => {
  const condition = /^ {8}if: (.+)$/m.exec(find(HOLD).text)?.[1];
  assert.ok(condition, 'the hold has an if: line');
  // The only way to skip: a manual run with the emergency input. Nothing else may appear.
  assert.equal(condition.replace(/\s+/g, ' '), "${{ !(github.event_name == 'workflow_dispatch' && inputs.deploy_while_live) }}");

  const inputs = /^ {2}workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n\npermissions:/m.exec(workflow)?.[1] ?? '';
  const block = /^ {6}deploy_while_live:\n((?: {8}.+\n?)+)/m.exec(inputs)?.[1] ?? '';
  assert.match(block, /type: boolean/);
  assert.match(block, /default: false/);
  // The push trigger carries no inputs and no filters that could bypass the step.
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/m);
});

test('the classify step uses full history and the catch-up command, and keeps its outputs', () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.doesNotMatch(workflow, /fetch-depth: 2/);
  const classify = find('Classify changed paths');
  assert.ok(classify.start < find(HOLD).start);
  assert.match(classify.text, /node scripts\/classify-service-lag\.mjs --files-from changed-files\.txt --github-output "\$GITHUB_OUTPUT" --head "\$after"/);
  // Every manual run (not only an emergency one) must not restart a service nobody ticked.
  assert.match(classify.text, /SKIP_SERVICE_CATCH_UP: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(classify.text, /--skip-lag/);
  assert.doesNotMatch(classify.text, /--depth=/);
  // Later steps still read the same output names.
  assert.match(find('Trigger Render deploys').text, /steps\.changed-paths\.outputs\.signaling_changed/);
  assert.match(find('Trigger Render deploys').text, /steps\.changed-paths\.outputs\.media_changed/);
  assert.match(find('Verify production services').text, /steps\.changed-paths\.outputs\.signaling_changed/);
  assert.match(find('Verify production services').text, /steps\.changed-paths\.outputs\.media_changed/);
});

test('the time budget fits the job limit', () => {
  const jobLimit = Number(/^ {4}timeout-minutes: (\d+)/m.exec(workflow)?.[1]);
  const holdLimit = Number(/^ {8}timeout-minutes: (\d+)/m.exec(find(HOLD).text)?.[1]);
  const budget = Number(/MEDIA_IDLE_BUDGET_MINUTES: (\d+)/.exec(find(HOLD).text)?.[1]);
  assert.equal(jobLimit, 45);
  assert.ok(budget > 0 && budget < holdLimit, 'the step limit leaves room for the last poll');
  const waits = (name) => Number(/PRODUCTION_CHECK_WAIT_MS: (\d+)/.exec(find(name).text)?.[1]) / 60_000;
  const later = 2 + waits('Verify static client cache') + waits('Verify production services');
  const beforeHold = 10; // install, build and test: about 5 minutes, 10 at worst
  assert.ok(beforeHold + holdLimit + later <= jobLimit, `${beforeHold} + ${holdLimit} + ${later} must fit in ${jobLimit}`);
});

test('the catch-up command writes the output names the later steps read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-lag-'));
  const files = join(dir, 'changed.txt');
  const output = join(dir, 'output.txt');
  writeFileSync(files, 'client/src/App.tsx\nmedia-server/src/index.ts\n');
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./classify-service-lag.mjs', import.meta.url)),
    '--files-from', files, '--github-output', output, '--skip-lag',
  ], { stdio: 'pipe' });
  const lines = readFileSync(output, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    'signaling_changed=false',
    'media_changed=true',
    'signaling_files=',
    'media_files=media-server/src/index.ts',
  ]);
});
