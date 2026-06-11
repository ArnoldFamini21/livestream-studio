import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllowedOrigins, isAllowedOrigin, normalizeOrigin } from './origins.js';

describe('media server origin policy', () => {
  it('normalizes origins and ignores invalid configured values', () => {
    assert.equal(normalizeOrigin('https://studio.example.com/path?x=1'), 'https://studio.example.com');
    assert.equal(normalizeOrigin('not-a-url'), null);
  });

  it('includes default and configured client origins', () => {
    const allowedOrigins = buildAllowedOrigins(
      'https://preview.example.com/app, http://localhost:4173 , invalid'
    );

    assert.equal(allowedOrigins.has('https://studio.arnoldfamini.com'), true);
    assert.equal(allowedOrigins.has('http://localhost:5173'), true);
    assert.equal(allowedOrigins.has('https://preview.example.com'), true);
    assert.equal(allowedOrigins.has('http://localhost:4173'), true);
    assert.equal(allowedOrigins.has('invalid'), false);
  });

  it('allows only configured origins when an Origin header is present', () => {
    const allowedOrigins = buildAllowedOrigins('https://preview.example.com');

    assert.equal(isAllowedOrigin('https://preview.example.com/join/abc', { allowedOrigins, production: true }), true);
    assert.equal(isAllowedOrigin('https://evil.example.com', { allowedOrigins, production: true }), false);
  });

  it('rejects missing Origin headers in production but allows them during local development', () => {
    const allowedOrigins = buildAllowedOrigins();

    assert.equal(isAllowedOrigin(undefined, { allowedOrigins, production: true }), false);
    assert.equal(isAllowedOrigin(undefined, { allowedOrigins, production: false }), true);
  });
});
