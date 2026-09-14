// Keep the picker request synchronous with the user's click. A late permission
// result must never restart capture after the user has stopped or left the studio.
export function createScreenCaptureSession(capture: () => Promise<MediaStream>) {
  let generation = 0;
  let pending = false;
  let stream: MediaStream | null = null;

  const release = (value: MediaStream) => value.getTracks().forEach(track => track.stop());

  return {
    async start(): Promise<MediaStream | null> {
      if (pending || stream) return null;
      pending = true;
      const request = ++generation;
      try {
        const result = await capture();
        const video = result.getVideoTracks()[0];
        if (request !== generation || !video || video.readyState === 'ended') {
          release(result);
          return null;
        }
        // Preserve text detail when the browser chooses an encoder strategy.
        try { video.contentHint = 'detail'; } catch { /* Optional browser hint. */ }
        stream = result;
        return result;
      } finally {
        pending = false;
      }
    },
    stop() {
      generation++;
      if (stream) release(stream);
      stream = null;
    },
  };
}
