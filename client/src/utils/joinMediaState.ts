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
