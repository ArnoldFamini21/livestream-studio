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
  const installs = dockerfile.match(/^RUN npm ci.*$/gm) || [];
  const copies = dockerfile.match(/^COPY package\.json package-lock\.json \.npmrc \.\/$/gm) || [];
  assert.ok(installs.length > 0);
  assert.equal(copies.length, installs.length, 'every Docker install stage has the .npmrc');
});

test('the Render signaling build installs only the server and shared workspaces', () => {
  const render = readFileSync(join(root, 'render.yaml'), 'utf8');
  const build = render.match(/^\s*buildCommand:\s*(.+)$/m)?.[1] || '';
  assert.match(build, /npm ci --include=dev --workspace=server --workspace=shared --include-workspace-root/);
});
