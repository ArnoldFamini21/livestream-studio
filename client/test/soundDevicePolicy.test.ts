import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  areProcessingSoundDevicesReleased,
  registerProcessingAudioContext,
  releaseProcessingSoundDevices,
  resetSoundDevicePolicyForTests,
  restoreProcessingSoundDevices,
} from '../src/audio/soundDevicePolicy.ts';

/** The part of an AudioContext the policy touches. */
function fakeContext(options: { setSinkId?: 'works' | 'rejects' | 'throws' | 'missing' } = {}) {
  const calls: unknown[] = [];
  const context: { state: string; calls: unknown[]; setSinkId?: (id: unknown) => Promise<void> } = { state: 'running', calls };
  const mode = options.setSinkId ?? 'works';
  if (mode !== 'missing') {
    context.setSinkId = (id: unknown) => {
      calls.push(id);
      if (mode === 'throws') throw new Error('no sink');
      return mode === 'rejects' ? Promise.reject(new Error('no sink')) : Promise.resolve();
    };
  }
  return context;
}
const asContext = (context: object) => context as unknown as AudioContext;

describe('sound device policy for voice contexts', () => {
  beforeEach(() => resetSoundDevicePolicyForTests());

  it('does nothing to a context in normal use', () => {
    const voice = fakeContext();
    registerProcessingAudioContext(asContext(voice));
    assert.deepEqual(voice.calls, [], 'registering alone never changes the sound device');
    assert.equal(areProcessingSoundDevicesReleased(), false);
    // Getting the sound "back" when it never went away changes nothing either.
    restoreProcessingSoundDevices();
    assert.deepEqual(voice.calls, []);
  });

  it('takes the sound device away from every registered context when the studio sound output goes off, and gives it back', () => {
    const first = fakeContext();
    const second = fakeContext();
    registerProcessingAudioContext(asContext(first));
    registerProcessingAudioContext(asContext(second));

    releaseProcessingSoundDevices();
    assert.equal(areProcessingSoundDevicesReleased(), true);
    assert.deepEqual(first.calls, [{ type: 'none' }]);
    assert.deepEqual(second.calls, [{ type: 'none' }]);

    restoreProcessingSoundDevices();
    assert.equal(areProcessingSoundDevicesReleased(), false);
    assert.deepEqual(first.calls, [{ type: 'none' }, '']);
    assert.deepEqual(second.calls, [{ type: 'none' }, '']);
  });

  it('starts a context without a sound device while the output is off, and normally again afterwards', () => {
    releaseProcessingSoundDevices();
    const during = fakeContext();
    registerProcessingAudioContext(asContext(during));
    assert.deepEqual(during.calls, [{ type: 'none' }]);

    restoreProcessingSoundDevices();
    assert.deepEqual(during.calls, [{ type: 'none' }, '']);
    const after = fakeContext();
    registerProcessingAudioContext(asContext(after));
    assert.deepEqual(after.calls, []);
  });

  it('forgets a context that was unregistered or closed', () => {
    const gone = fakeContext();
    const closed = fakeContext();
    const kept = fakeContext();
    const forget = registerProcessingAudioContext(asContext(gone));
    registerProcessingAudioContext(asContext(closed));
    registerProcessingAudioContext(asContext(kept));
    forget();
    closed.state = 'closed';

    releaseProcessingSoundDevices();
    assert.deepEqual(gone.calls, []);
    assert.deepEqual(closed.calls, []);
    assert.deepEqual(kept.calls, [{ type: 'none' }]);
  });

  it('never throws: a browser without setSinkId, one that rejects, one that throws', async () => {
    const missing = fakeContext({ setSinkId: 'missing' });
    const rejects = fakeContext({ setSinkId: 'rejects' });
    const throws = fakeContext({ setSinkId: 'throws' });
    for (const context of [missing, rejects, throws]) registerProcessingAudioContext(asContext(context));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      assert.doesNotThrow(() => releaseProcessingSoundDevices());
      assert.doesNotThrow(() => restoreProcessingSoundDevices());
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, [], 'a rejected switch is swallowed');
    assert.deepEqual(rejects.calls, [{ type: 'none' }, '']);
  });

  it('releasing twice does not switch twice into a different state, and a second restore does nothing', () => {
    const voice = fakeContext();
    registerProcessingAudioContext(asContext(voice));
    releaseProcessingSoundDevices();
    restoreProcessingSoundDevices();
    restoreProcessingSoundDevices();
    assert.deepEqual(voice.calls, [{ type: 'none' }, '']);
  });
});
