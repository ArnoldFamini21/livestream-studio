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

export interface LocalTrackKinds {
  audio: boolean;
  video: boolean;
}

/** Which kinds of live capture track a stream has. */
export function getLocalTrackKinds(stream: MediaStream | null): LocalTrackKinds {
  return {
    audio: Boolean(stream?.getAudioTracks().some((track) => track.readyState === 'live')),
    video: Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live')),
  };
}

/**
 * Apply the host's current media controls after a device track is replaced.
 * A kind that had no track before (`previousKinds`) is a device that just
 * started (a retry, or the user turning it on); its own enabled state is the
 * user's choice and must not be switched off by the stale participant flag.
 */
export function applyParticipantMediaState(
  participant: Participant | null,
  stream: MediaStream | null,
  setAudioEnabled: (enabled: boolean) => unknown,
  setVideoEnabled: (enabled: boolean) => unknown,
  previousKinds: LocalTrackKinds = { audio: true, video: true },
): void {
  if (!participant || !stream) return;
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack && previousKinds.audio && audioTrack.enabled !== participant.audioEnabled) {
    audioTrack.enabled = participant.audioEnabled;
    setAudioEnabled(participant.audioEnabled);
  }
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack && previousKinds.video && videoTrack.enabled !== participant.videoEnabled) {
    videoTrack.enabled = participant.videoEnabled;
    setVideoEnabled(participant.videoEnabled);
  }
}
