// Keep the picker request synchronous with the user's click. A late permission
// result must never restart capture after the user has stopped or left the studio.
export function createScreenCaptureSession(capture: () => Promise<MediaStream>) {
  let generation = 0;
  let pending = false;
  let stream: MediaStream | null = null;

  const release = (value: MediaStream) => value.getTracks().forEach(track => track.stop());

  return {
    /** `contentHint`: 'detail' keeps text sharp (slides, documents); 'motion' keeps a shared video smooth. */
    async start(contentHint: 'detail' | 'motion' = 'detail'): Promise<MediaStream | null> {
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
        // Tell the encoder what matters: text detail, or motion.
        try { video.contentHint = contentHint; } catch { /* Optional browser hint. */ }
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
