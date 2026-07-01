import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateClientCacheHeaders,
  evaluateHostAccessCreateResponse,
  normalizeProductionCheckScope,
} from './check-production.mjs';

test('normalizes production check scopes', () => {
  assert.equal(normalizeProductionCheckScope('all'), 'all');
  assert.equal(normalizeProductionCheckScope('client'), 'client');
  assert.equal(normalizeProductionCheckScope('static'), 'client');
  assert.equal(normalizeProductionCheckScope('services'), 'services');
  assert.equal(normalizeProductionCheckScope('server'), 'services');
  assert.throws(() => normalizeProductionCheckScope('database'), /Unsupported PRODUCTION_CHECK_SCOPE/);
});

test('accepts CDN-ready client cache headers', () => {
  const result = evaluateClientCacheHeaders({
    htmlCacheControl: 'no-cache, no-store, must-revalidate',
    assetCacheControl: 'public, max-age=31536000, immutable',
    assetExpires: 'Thu, 01 Jul 2027 21:17:52 GMT',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.assetMaxAge, 31536000);
});

test('rejects weak client cache headers', () => {
  const result = evaluateClientCacheHeaders({
    htmlCacheControl: '',
    assetCacheControl: 'public, max-age=604800',
    assetExpires: '0',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Client HTML/);
  assert.match(result.errors.join('\n'), /at least one year/);
  assert.match(result.errors.join('\n'), /immutable/);
  assert.match(result.errors.join('\n'), /Expires: 0/);
});

test('accepts create studio responses with private host access', () => {
  const result = evaluateHostAccessCreateResponse({
    id: 'room-123',
    name: 'Production check',
    hostName: 'Arnold',
    hostToken: 'validHostToken_1234567890',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.roomId, 'room-123');
  assert.equal(result.hostTokenLength, 25);
});

test('rejects create studio responses that omit host access', () => {
  const result = evaluateHostAccessCreateResponse({
    id: 'room-123',
    name: 'Production check',
    hostName: 'Arnold',
    hostId: '',
    coHostIds: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /valid private hostToken/);
});
