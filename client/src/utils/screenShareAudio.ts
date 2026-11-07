/**
 * The SFU carries one audio track per publisher. While someone shares a tab or
 * the system sound through the SFU, that sound is mixed into the track they
 * publish there so everyone on stage (and the host's program mix) hears it.
 * On the mesh it travels as its own track instead (see useWebRTC.publishScreenTrack).
 */

export interface MixedScreenAudio {
  track: MediaStreamTrack;
  dispose(): void;
}

type AudioGraphContext = Pick<AudioContext, 'createMediaStreamDestination' | 'createMediaStreamSource'>;

export function mixScreenAudioWithVoice(
  context: AudioGraphContext,
  voiceTrack: MediaStreamTrack | null,
  screenAudioTrack: MediaStreamTrack,
): MixedScreenAudio | null {
  const destination = context.createMediaStreamDestination();
  const sources: AudioNode[] = [];
  try {
    for (const track of [voiceTrack, screenAudioTrack]) {
      if (!track || track.readyState !== 'live') continue;
      const source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(destination);
      sources.push(source);
    }
  } catch (err) {
    for (const source of sources) source.disconnect();
    console.warn('Screen audio could not be mixed for the SFU:', err);
    return null;
  }
  const track = destination.stream.getAudioTracks()[0];
  if (!track || sources.length === 0) {
    for (const source of sources) source.disconnect();
    return null;
  }
  // A muted microphone (track.enabled = false) is silence in the mix; the shared sound continues.
  return {
    track,
    dispose() {
      for (const source of sources) {
        try { source.disconnect(); } catch { /* Already disconnected. */ }
      }
      track.stop();
    },
  };
}
