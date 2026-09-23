import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLastActive, describeUserAgent } from '../src/utils/userAgentLabel.ts';
import { readPasswordResetToken } from '../src/utils/accountAuth.ts';

describe('session device labels', () => {
  it('names common browsers and platforms', () => {
    assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'), 'Chrome on macOS');
    assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
    assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0'), 'Edge on Windows');
    assert.equal(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'), 'Chrome on Android');
    assert.equal(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox on Linux');
    assert.equal(describeUserAgent(''), 'Unknown device');
    assert.equal(describeUserAgent('curl/8.5.0'), 'Unknown device');
  });

  it('describes when a session was last active', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    assert.equal(describeLastActive('2026-09-23T11:57:00Z', now), 'Active now');
    assert.equal(describeLastActive('2026-09-23T11:20:00Z', now), 'Active 40 min ago');
    assert.equal(describeLastActive('2026-09-23T09:00:00Z', now), 'Active 3 hr ago');
    assert.equal(describeLastActive('2026-09-22T12:00:00Z', now), 'Active 1 day ago');
    assert.equal(describeLastActive('not a date', now), '');
  });
});

describe('password reset link', () => {
  it('reads the token from the fragment only when it is well formed', () => {
    const token = 'a'.repeat(43);
    assert.equal(readPasswordResetToken(`#token=${token}`), token);
    assert.equal(readPasswordResetToken(`token=${token}`), token);
    assert.equal(readPasswordResetToken('#token=short'), '');
    assert.equal(readPasswordResetToken('#token=<script>'), '');
    assert.equal(readPasswordResetToken(''), '');
  });
});
