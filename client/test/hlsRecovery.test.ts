import assert from 'node:assert/strict';
import { it } from 'node:test';
import { HlsRecoveryPolicy, PLAYBACK_FAILED_MESSAGE, UNSUPPORTED_FORMAT_MESSAGE } from '../src/utils/hlsRecovery.ts';

it('stops at once when the browser cannot decode the stream', () => {
  const policy = new HlsRecoveryPolicy();
  for (const details of ['bufferAddCodecError', 'bufferIncompatibleCodecsError', 'manifestIncompatibleCodecsError']) {
    assert.deepEqual(policy.next({ type: 'mediaError', details }), { action: 'fail', message: UNSUPPORTED_FORMAT_MESSAGE });
  }
});

it('backs off network retries up to ten seconds and resets once playback resumes', () => {
  const policy = new HlsRecoveryPolicy();
  const delays = Array.from({ length: 7 }, () => {
    const step = policy.next({ type: 'networkError', details: 'manifestLoadError' });
    assert.equal(step.action, 'reload');
    return step.action === 'reload' ? step.delayMs : 0;
  });
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  policy.recovered();
  assert.deepEqual(policy.next({ type: 'networkError', details: 'fragLoadError' }), { action: 'reload', delayMs: 1000 });
});

it('recovers media errors, then swaps audio, then gives up when errors keep coming', () => {
  const policy = new HlsRecoveryPolicy();
  const error = { type: 'mediaError', details: 'bufferStalledError' };
  assert.deepEqual(policy.next(error, 10_000), { action: 'recover-media' });
  assert.deepEqual(policy.next(error, 11_000), { action: 'swap-audio-and-recover' });
  assert.deepEqual(policy.next(error, 12_000), { action: 'fail', message: PLAYBACK_FAILED_MESSAGE });
});

it('allows another plain recovery when media errors are far apart', () => {
  const policy = new HlsRecoveryPolicy();
  const error = { type: 'mediaError', details: 'bufferAppendError' };
  assert.deepEqual(policy.next(error, 10_000), { action: 'recover-media' });
  assert.deepEqual(policy.next(error, 60_000), { action: 'recover-media' });
});

it('gives up on other fatal errors', () => {
  const policy = new HlsRecoveryPolicy();
  assert.deepEqual(policy.next({ type: 'otherError', details: 'internalException' }), { action: 'fail', message: PLAYBACK_FAILED_MESSAGE });
});
