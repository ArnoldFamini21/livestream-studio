// Shared AudioContext singleton to avoid hitting browser limits.
// Browsers typically allow only 6-8 concurrent AudioContext instances.

let sharedContext: AudioContext | null = null;
let refCount = 0;

export function acquireAudioContext(): AudioContext {
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
  refCount--;
  // Don't close — keep alive for reuse. Only close if truly no consumers.
  if (refCount <= 0 && sharedContext) {
    refCount = 0;
    // Defer close slightly in case new consumers appear immediately
    setTimeout(() => {
      if (refCount <= 0 && sharedContext) {
        sharedContext.close().catch(() => {});
        sharedContext = null;
      }
    }, 5000);
  }
}
