import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STUDIO_CAPABILITIES, hasStudioCapability, sanitizeStudioCapabilities } from '../dist/index.js';

describe('studio capabilities', () => {
  it('keeps only known capabilities, once each', () => {
    assert.deepEqual(
      sanitizeStudioCapabilities(['program-return', 'nope', 'program-return', 42, 'talkback']),
      ['program-return', 'talkback']
    );
    assert.deepEqual(sanitizeStudioCapabilities(undefined), []);
    assert.deepEqual(sanitizeStudioCapabilities('program-return'), []);
    assert.deepEqual(sanitizeStudioCapabilities([...STUDIO_CAPABILITIES]), [...STUDIO_CAPABILITIES]);
  });

  it('treats a participant without the flag (older client or server) as lacking it', () => {
    assert.equal(hasStudioCapability({ capabilities: ['program-return'] }, 'program-return'), true);
    assert.equal(hasStudioCapability({ capabilities: ['talkback'] }, 'program-return'), false);
    assert.equal(hasStudioCapability({}, 'program-return'), false);
    assert.equal(hasStudioCapability(null, 'talkback'), false);
  });
});
