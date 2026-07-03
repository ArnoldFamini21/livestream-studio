#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SIGNALING_PREFIXES = ['server/', 'shared/'];
const MEDIA_PREFIXES = ['media-server/', 'shared/'];
const GLOBAL_SERVICE_FILES = new Set(['package.json', 'render.yaml']);

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

export function classifyProductionChanges(files = []) {
  const normalizedFiles = files
    .map(normalizePath)
    .filter(Boolean);

  const signalingFiles = [];
  const mediaFiles = [];
  const hasSignalingWorkspaceDependencyChange = normalizedFiles.some((file) => (
    file === 'server/package.json' ||
    file === 'shared/package.json'
  ));
  const hasMediaWorkspaceDependencyChange = normalizedFiles.some((file) => (
    file === 'media-server/package.json' ||
    file === 'shared/package.json'
  ));

  for (const file of normalizedFiles) {
    const isPackageLock = file === 'package-lock.json';
    const packageLockMatchesSignaling = isPackageLock && (hasSignalingWorkspaceDependencyChange || !hasMediaWorkspaceDependencyChange);
    const packageLockMatchesMedia = isPackageLock && (hasMediaWorkspaceDependencyChange || !hasSignalingWorkspaceDependencyChange);

    if (GLOBAL_SERVICE_FILES.has(file) || packageLockMatchesSignaling || SIGNALING_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      signalingFiles.push(file);
    }
    if (GLOBAL_SERVICE_FILES.has(file) || packageLockMatchesMedia || MEDIA_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      mediaFiles.push(file);
    }
  }

  return {
    files: normalizedFiles,
    signalingChanged: signalingFiles.length > 0,
    mediaChanged: mediaFiles.length > 0,
    signalingFiles,
    mediaFiles,
  };
}

function parseArgs(argv) {
  const args = {
    githubOutput: '',
    files: [],
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--github-output') {
      args.githubOutput = argv[++index] || '';
      continue;
    }
    if (arg === '--files-from') {
      const filePath = argv[++index] || '';
      const text = readFileSync(filePath, 'utf8');
      args.files.push(...text.split(/\r?\n/));
      continue;
    }
    args.files.push(arg);
  }

  return args;
}

function writeGithubOutputs(filePath, classification) {
  if (!filePath) return;
  const lines = [
    `signaling_changed=${classification.signalingChanged}`,
    `media_changed=${classification.mediaChanged}`,
    `signaling_files=${classification.signalingFiles.join(',')}`,
    `media_files=${classification.mediaFiles.join(',')}`,
  ];
  appendFileSync(filePath, `${lines.join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const classification = classifyProductionChanges(args.files);
  writeGithubOutputs(args.githubOutput, classification);
  console.log(JSON.stringify(classification, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
