import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOGO_IMAGE_MAX_BYTES,
  MAX_INLINE_BRANDING_DATA_URL_LENGTH,
  SIGNALING_MAX_PAYLOAD_BYTES,
  SIGNALING_SAFE_MESSAGE_BYTES,
} from '../dist/index.js';

describe('signaling size limits', () => {
  it('keeps the client send limit below the server cap, with headroom', () => {
    assert.equal(SIGNALING_MAX_PAYLOAD_BYTES, 64 * 1024);
    assert.ok(SIGNALING_SAFE_MESSAGE_BYTES <= SIGNALING_MAX_PAYLOAD_BYTES - 4 * 1024);
  });

  it('keeps inline branding pictures tiny and logos within the image store', () => {
    assert.ok(MAX_INLINE_BRANDING_DATA_URL_LENGTH * 2 < SIGNALING_SAFE_MESSAGE_BYTES);
    assert.ok(LOGO_IMAGE_MAX_BYTES > 0);
  });
});
