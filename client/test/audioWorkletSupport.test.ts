import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { hasAudioWorkletSupport } from '../src/utils/audioWorkletSupport.ts';
import { isAiNoiseRemovalSupported } from '../src/utils/aiNoiseRemoval.ts';
import { isPcmWavRecordingSupported } from '../src/utils/pcmWavRecorder.ts';

const scope = globalThis as Record<string, unknown>;
const saved = { AudioContext: scope.AudioContext, AudioWorkletNode: scope.AudioWorkletNode };

afterEach(() => {
  scope.AudioContext = saved.AudioContext;
  scope.AudioWorkletNode = saved.AudioWorkletNode;
});

/** Like Safari: the getter throws unless it is called on a real context. */
function installSafariLikeAudioContext() {
  class SafariAudioContext {}
  Object.defineProperty(SafariAudioContext.prototype, 'audioWorklet', {
    configurable: true,
    get() {
      if (!(this instanceof SafariAudioContext) || this === SafariAudioContext.prototype) {
        throw new TypeError('The BaseAudioContext.audioWorklet getter can only be used on instances of BaseAudioContext');
      }
      return {};
    },
  });
  scope.AudioContext = SafariAudioContext;
  scope.AudioWorkletNode = class {};
}

describe('AudioWorklet feature check', () => {
  it('does not call the audioWorklet getter on the prototype (Safari throws there)', () => {
    installSafariLikeAudioContext();
    assert.equal(hasAudioWorkletSupport(), true);
    assert.equal(isPcmWavRecordingSupported(), true);
    assert.equal(isAiNoiseRemovalSupported(), true);
  });

  it('reports no support when AudioContext or AudioWorkletNode is missing', () => {
    scope.AudioContext = class {};
    scope.AudioWorkletNode = class {};
    assert.equal(hasAudioWorkletSupport(), false, 'no audioWorklet on the prototype');
    delete scope.AudioContext;
    assert.equal(hasAudioWorkletSupport(), false);
    assert.equal(isPcmWavRecordingSupported(), false);
    assert.equal(isAiNoiseRemovalSupported(), false);
  });
});
