import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiRequestError } from '../src/utils/apiClient.ts';
import {
  STUDIO_ACCESS_KEY_STORAGE_KEY,
  buildStudioCreateHeaders,
  getStoredStudioAccessKey,
  isStudioAccessRequiredError,
  normalizeStudioAccessKey,
  saveStudioAccessKey,
  type StudioAccessKeyStorage,
} from '../src/utils/studioAccessKey.ts';

function memoryStorage(): StudioAccessKeyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('studio access key', () => {
  it('saves, reads and forgets the key under studioAccessKey', () => {
    const storage = memoryStorage();
    assert.equal(saveStudioAccessKey('  owner-key\n', storage), 'owner-key');
    assert.equal(storage.data.get(STUDIO_ACCESS_KEY_STORAGE_KEY), 'owner-key');
    assert.equal(getStoredStudioAccessKey(storage), 'owner-key');
    saveStudioAccessKey('', storage);
    assert.equal(storage.data.has(STUDIO_ACCESS_KEY_STORAGE_KEY), false);
    assert.equal(getStoredStudioAccessKey(null), '');
  });

  it('sends the key as X-Studio-Access-Key only when there is one', () => {
    assert.equal(buildStudioCreateHeaders('owner-key').get('X-Studio-Access-Key'), 'owner-key');
    assert.equal(buildStudioCreateHeaders('').has('X-Studio-Access-Key'), false);
    assert.equal(normalizeStudioAccessKey('x'.repeat(600)).length, 512);
  });

  it('recognizes the server asking for the owner key', () => {
    const body = JSON.stringify({ error: 'needs key', code: 'STUDIO_ACCESS_REQUIRED' });
    assert.equal(isStudioAccessRequiredError(new ApiRequestError('needs key', { status: 401, responseText: body })), true);
    assert.equal(isStudioAccessRequiredError(new ApiRequestError('needs key', { status: 403, responseText: body })), true);
    assert.equal(isStudioAccessRequiredError(new ApiRequestError('quota', { status: 429, responseText: body })), false);
    assert.equal(isStudioAccessRequiredError(new ApiRequestError('other', { status: 403, responseText: '{"code":"OTHER"}' })), false);
    assert.equal(isStudioAccessRequiredError(new Error('plain')), false);
  });
});
