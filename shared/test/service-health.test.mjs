import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildServiceHealthPayload } from '../dist/index.js';

describe('service health payloads', () => {
  it('includes non-sensitive deployment metadata from environment values', () => {
    assert.deepEqual(
      buildServiceHealthPayload('media-server', {
        npm_package_version: '1.2.3',
        RENDER_GIT_COMMIT: 'abcdef1234567890',
        NODE_ENV: 'production',
      }),
      {
        status: 'ok',
        service: 'media-server',
        version: '1.2.3',
        commit: 'abcdef1234567890',
        environment: 'production',
      }
    );
  });

  it('omits empty or invalid optional metadata', () => {
    assert.deepEqual(
      buildServiceHealthPayload('signaling-server', {
        npm_package_version: ' ',
        RENDER_GIT_COMMIT: 'not-a-sha',
        NODE_ENV: '',
      }),
      {
        status: 'ok',
        service: 'signaling-server',
      }
    );
  });
});
