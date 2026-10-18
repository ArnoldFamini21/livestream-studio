import type { Participant } from '@studio/shared';

/** The local device choice is authoritative at join/rejoin. Server defaults
 * must never turn a waiting-room microphone or camera back on. */
export function withLocalJoinMedia(participant: Participant, stream: MediaStream | null): Participant {
  return {
    ...participant,
    audioEnabled: Boolean(stream?.getAudioTracks().some(track => track.enabled && track.readyState === 'live')),
    videoEnabled: Boolean(stream?.getVideoTracks().some(track => track.enabled && track.readyState === 'live')),
  };
}

/** Device toggles refer to capture tracks, which may differ from background-effect output tracks. */
export function withLocalMediaChoice(participant: Participant, kind: 'audio' | 'video', enabled: boolean): Participant {
  return { ...participant, [kind === 'audio' ? 'audioEnabled' : 'videoEnabled']: enabled };
}

/** Apply the host's current media controls after a device track is replaced. */
export function applyParticipantMediaState(
  participant: Participant | null,
  stream: MediaStream | null,
  setAudioEnabled: (enabled: boolean) => unknown,
  setVideoEnabled: (enabled: boolean) => unknown,
): void {
  if (!participant || !stream) return;
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack && audioTrack.enabled !== participant.audioEnabled) {
    audioTrack.enabled = participant.audioEnabled;
    setAudioEnabled(participant.audioEnabled);
  }
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack && videoTrack.enabled !== participant.videoEnabled) {
    videoTrack.enabled = participant.videoEnabled;
    setVideoEnabled(participant.videoEnabled);
  }
}
