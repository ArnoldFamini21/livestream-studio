/**
 * Whether AudioContext has an audioWorklet, checked without calling the getter.
 * Reading `AudioContext.prototype.audioWorklet` throws in Safari ("The
 * BaseAudioContext.audioWorklet getter can only be used on instances of
 * BaseAudioContext"), which used to break the microphone setup there.
 */
export function hasAudioWorkletSupport(): boolean {
  try {
    if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') return false;
    return 'audioWorklet' in AudioContext.prototype;
  } catch {
    return false;
  }
}
