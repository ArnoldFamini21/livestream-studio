import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProductionChanges } from './classify-production-changes.mjs';

test('classifies client-only and docs changes as static-only', () => {
  const result = classifyProductionChanges([
    'client/src/components/HomePage.tsx',
    'docs/render-deployment.md',
    '.github/workflows/deploy.yml',
  ]);

  assert.equal(result.signalingChanged, false);
  assert.equal(result.mediaChanged, false);
  assert.deepEqual(result.signalingFiles, []);
  assert.deepEqual(result.mediaFiles, []);
});

test('classifies signaling service changes', () => {
  const result = classifyProductionChanges([
    'server/src/services/signaling.ts',
    './server/package.json',
  ]);

  assert.equal(result.signalingChanged, true);
  assert.equal(result.mediaChanged, false);
  assert.deepEqual(result.signalingFiles, [
    'server/src/services/signaling.ts',
    'server/package.json',
  ]);
  assert.deepEqual(result.mediaFiles, []);
});

test('classifies media service changes', () => {
  const result = classifyProductionChanges([
    'media-server/src/index.ts',
    'media-server/package.json',
  ]);

  assert.equal(result.signalingChanged, false);
  assert.equal(result.mediaChanged, true);
  assert.deepEqual(result.signalingFiles, []);
  assert.deepEqual(result.mediaFiles, [
    'media-server/src/index.ts',
    'media-server/package.json',
  ]);
});

test('classifies shared and deployment config changes as both services', () => {
  const result = classifyProductionChanges([
    'shared/src/index.ts',
    'package-lock.json',
    'render.yaml',
  ]);

  assert.equal(result.signalingChanged, true);
  assert.equal(result.mediaChanged, true);
  assert.deepEqual(result.signalingFiles, [
    'shared/src/index.ts',
    'package-lock.json',
    'render.yaml',
  ]);
  assert.deepEqual(result.mediaFiles, [
    'shared/src/index.ts',
    'package-lock.json',
    'render.yaml',
  ]);
});
