import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = ['.', 'client', 'server', 'media-server', 'shared'];

/** Licences any direct dependency may carry without review. */
const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'OFL-1.1',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Unlicense',
]);

/**
 * Reviewed exceptions, each with the reason it is acceptable. Adding a
 * dependency that is not permissive means adding it here deliberately.
 */
const REVIEWED = new Map([
  // Bundled unmodified into the client (cleaned render). MPL-2.0 is file-level
  // copyleft: recipients are pointed at the covered source in THIRD_PARTY_LICENSES.txt.
  ['mediabunny', 'MPL-2.0'],
  // Runs only on the media server (FFmpeg binary for the RTMP relay); not distributed to users.
  ['ffmpeg-static', 'GPL-3.0-or-later'],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function installedLicense(workspace, name) {
  for (const base of [join(root, workspace, 'node_modules', name), join(root, 'node_modules', name)]) {
    const manifest = join(base, 'package.json');
    if (!existsSync(manifest)) continue;
    const data = readJson(manifest);
    if (typeof data.license === 'string') return data.license;
    if (data.license?.type) return data.license.type;
    return null;
  }
  return undefined;
}

/** True when an SPDX expression can be used under a permissive licence (any OR branch). */
function isPermissive(expression) {
  const clean = expression.replace(/[()]/g, ' ').trim();
  return clean.split(/\s+OR\s+/i).some((branch) => {
    const parts = branch.trim().split(/\s+AND\s+/i);
    return parts.every((part) => PERMISSIVE.has(part.trim()));
  });
}

test('every direct dependency is permissively licensed or a reviewed exception', () => {
  const problems = [];
  for (const workspace of WORKSPACES) {
    const manifest = readJson(join(root, workspace, 'package.json'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[section] || {})) {
        if (name.startsWith('@studio/')) continue;
        const license = installedLicense(workspace, name);
        if (license === undefined) continue; // Not installed here (e.g. a platform-only optional dependency).
        if (license && isPermissive(license)) continue;
        if (REVIEWED.get(name) === license) continue;
        problems.push(`${workspace}/${section}: ${name} (${license ?? 'no licence field'})`);
      }
    }
  }
  assert.deepEqual(problems, [], 'Add a permissive alternative, or review the licence and list it in REVIEWED');
});

test('the MPL-2.0 dependency bundled into the client is named, with its source, in the shipped notices', () => {
  const notices = readFileSync(join(root, 'client', 'public', 'THIRD_PARTY_LICENSES.txt'), 'utf8');
  const version = readJson(join(root, 'client', 'node_modules', 'mediabunny', 'package.json')).version;
  assert.match(notices, /mediabunny/);
  assert.match(notices, /MPL-2\.0/);
  assert.match(notices, /https:\/\/github\.com\/Vanilagy\/mediabunny/);
  assert.ok(notices.includes(`mediabunny ${version}`), `notices name mediabunny ${version}`);
});

test('installs skip the unused onnxruntime-node CUDA download everywhere', () => {
  const npmrc = readFileSync(join(root, '.npmrc'), 'utf8');
  assert.match(npmrc, /^onnxruntime-node-install=skip$/m);
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  // Install stages run npm ci, possibly inside a retry loop.
  const installs = dockerfile.match(/^RUN .*\bnpm ci\b.*$/gm) || [];
  const copies = dockerfile.match(/^COPY package\.json package-lock\.json \.npmrc \.\/$/gm) || [];
  assert.ok(installs.length > 0);
  assert.equal(copies.length, installs.length, 'every Docker install stage has the .npmrc');
});

test('the Render signaling build installs only the server and shared workspaces', () => {
  const render = readFileSync(join(root, 'render.yaml'), 'utf8');
  const build = render.match(/^\s*buildCommand:\s*(.+)$/m)?.[1] || '';
  assert.match(build, /npm ci --include=dev --workspace=server --workspace=shared --include-workspace-root/);
});

test('installs retry transient download failures in CI and deploy', () => {
  for (const workflow of ['ci.yml', 'deploy.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8');
    assert.doesNotMatch(text, /^\s*(run:\s*)?npm ci\b/m, `${workflow} installs through scripts/npm-ci-retry.sh`);
    assert.match(text, /sh scripts\/npm-ci-retry\.sh/);
  }
});

test('CI and deploy install FFmpeg through the bounded two-source script', () => {
  let jobCount = 0;
  for (const workflow of ['ci.yml', 'deploy.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8');
    const jobs = text.split(/^  (?=[a-z-]+:\n)/m).filter((block) => /npm-ci-retry/.test(block));
    for (const job of jobs) {
      jobCount += 1;
      const install = job.indexOf('sh scripts/ci-install-ffmpeg.sh');
      assert.ok(install >= 0, `${workflow}: FFmpeg comes from scripts/ci-install-ffmpeg.sh`);
      assert.ok(install < job.indexOf('npm-ci-retry'), `${workflow}: FFmpeg is installed before npm ci`);

      // The script exports FFMPEG_BIN only when the system binary works. A fixed value
      // would make ffmpeg-static skip its GitHub download even after the Ubuntu install
      // failed, which leaves the job with no FFmpeg from either source.
      assert.doesNotMatch(job, /^\s*FFMPEG_BIN:/m, `${workflow}: FFMPEG_BIN is not hard-coded`);

      // An export reaches only later steps, so npm ci cannot share the script's step.
      const nextStep = job.indexOf('\n      - ', install);
      const restOfStep = job.slice(install, nextStep === -1 ? undefined : nextStep);
      assert.doesNotMatch(restOfStep, /npm-ci-retry/, `${workflow}: npm ci runs in a later step`);

      // Nothing may wait on a download without a limit: an unreachable Ubuntu mirror
      // once held `apt-get install` until the whole job was cancelled.
      const step = job.slice(job.lastIndexOf('- name:', install), install);
      assert.match(step, /timeout-minutes: \d+/, `${workflow}: the FFmpeg step has a time limit`);
      assert.match(job, /^    timeout-minutes: \d+$/m, `${workflow}: the job has a time limit`);
      assert.doesNotMatch(job, /apt-get (update|install)/, `${workflow}: no unbounded apt-get`);
      assert.doesNotMatch(job, /playwright-core install/, `${workflow}: Chromium comes from scripts/ci-install-chromium.sh`);
    }
  }
  assert.ok(jobCount >= 4);
});

test('CI and deploy jobs run on a named Ubuntu image, never ubuntu-latest', () => {
  // `ubuntu-latest` changed its FFmpeg major version under a green main: Ubuntu 26.04
  // ships FFmpeg 8, where four media-server tests fail, and deploy.yml runs those tests
  // before it publishes. A named image changes only when someone edits it on purpose.
  let jobCount = 0;
  for (const workflow of ['ci.yml', 'deploy.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8');
    const runners = [...text.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1].trim());
    assert.ok(runners.length > 0, `${workflow} declares its runners`);
    for (const runner of runners) {
      jobCount += 1;
      assert.match(runner, /^ubuntu-\d\d\.\d\d$/, `${workflow}: "${runner}" must be a named Ubuntu image`);
    }
  }
  assert.ok(jobCount >= 4);
});
