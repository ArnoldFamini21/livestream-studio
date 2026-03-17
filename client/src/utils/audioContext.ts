// Shared AudioContext singleton to avoid hitting browser limits.
// Browsers typically allow only 6-8 concurrent AudioContext instances.

let sharedContext: AudioContext | null = null;
let refCount = 0;
let closeTimeout: ReturnType<typeof setTimeout> | null = null;

export function acquireAudioContext(): AudioContext {
  if (closeTimeout) {
    clearTimeout(closeTimeout);
    closeTimeout = null;
  }
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext();
  }
  refCount++;
  // Resume if suspended (browsers require user gesture)
  if (sharedContext.state === 'suspended') {
    sharedContext.resume().catch(() => {});
  }
  return sharedContext;
}

export function releaseAudioContext(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && sharedContext) {
    closeTimeout = setTimeout(() => {
      if (refCount === 0 && sharedContext) {
        sharedContext.close().catch(() => {});
        sharedContext = null;
      }
      closeTimeout = null;
    }, 5000);
  }
}
