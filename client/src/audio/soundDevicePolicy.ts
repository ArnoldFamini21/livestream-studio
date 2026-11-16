/**
 * Audio contexts that only process sound on its way to the broadcast (the
 * voice clean-up of a microphone) and never play to the speakers.
 *
 * Chrome drives every audio context from the computer's sound output device.
 * When that device stops responding, a context can say "running" while
 * nothing in it renders. The studio's own context is rescued by taking the
 * sound device away from it (see programAudioClock.ts and
 * useBroadcastAudioBus). A voice context sits on the same device, so without
 * the same treatment the host's own voice would be missing from a broadcast
 * that otherwise came back.
 *
 * In normal use nothing changes: a registered context stays on the default
 * sound device, exactly as before. Only while the studio's sound output is
 * off are the registered contexts moved off the device too, and a context
 * created during that time starts without one. When the sound comes back,
 * they get the default device again.
 */

type SinkContext = AudioContext & { setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void> };

const contexts = new Set<AudioContext>();
let released = false;

function switchSink(context: AudioContext, sinkId: string | { type: 'none' }): void {
  try {
    const withSink = context as SinkContext;
    if (context.state === 'closed' || typeof withSink.setSinkId !== 'function') return;
    // Not awaited: a device that does not answer must not hold anything up.
    void Promise.resolve(withSink.setSinkId(sinkId)).catch(() => {});
  } catch {
    // The context keeps the device it has.
  }
}

function forgetClosed(): void {
  for (const context of contexts) {
    if (context.state === 'closed') contexts.delete(context);
  }
}

/**
 * Register a context that only feeds the broadcast. Returns the function that
 * forgets it; call it when the context is closed.
 */
export function registerProcessingAudioContext(context: AudioContext): () => void {
  forgetClosed();
  contexts.add(context);
  if (released) switchSink(context, { type: 'none' });
  return () => {
    contexts.delete(context);
  };
}

/** The studio's sound output was switched off: take the sound device away from the processing contexts too. */
export function releaseProcessingSoundDevices(): void {
  released = true;
  forgetClosed();
  for (const context of contexts) switchSink(context, { type: 'none' });
}

/** The studio's sound output is back on: give the processing contexts the default device again. */
export function restoreProcessingSoundDevices(): void {
  if (!released) return;
  released = false;
  forgetClosed();
  for (const context of contexts) switchSink(context, '');
}

export function areProcessingSoundDevicesReleased(): boolean {
  return released;
}

/** Tests only: forget every context and go back to normal use. */
export function resetSoundDevicePolicyForTests(): void {
  contexts.clear();
  released = false;
}
