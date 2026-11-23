import type { Participant } from '@studio/shared';

export const SFU_STAGE_THRESHOLD = 5;
export type SfuTransportStatus = 'idle' | 'connecting' | 'ready' | 'active' | 'fallback';

export interface SfuEligibilityInput {
  localParticipant: Participant | null;
  remoteParticipants: Iterable<Participant>;
  mediaServerReady: boolean;
  threshold?: number;
}

export type MediaStreamFactory = (tracks: MediaStreamTrack[]) => MediaStream;

function liveTracks(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  return tracks.filter((track) => track.readyState === 'live');
}

/**
 * The first SFU rollout is deliberately limited to the public on-stage mix.
 * Backstage participants keep the existing permission-aware mesh path.
 */
export function shouldUseSfuMedia(input: SfuEligibilityInput): boolean {
  if (!input.mediaServerReady || input.localParticipant?.status !== 'on-stage') return false;
  const threshold = Math.max(2, Math.floor(input.threshold ?? SFU_STAGE_THRESHOLD));
  let onStageCount = 1;
  for (const participant of input.remoteParticipants) {
    if (participant.status === 'on-stage') onStageCount += 1;
  }
  return onStageCount >= threshold;
}

/**
 * Keep the camera and mic on the SFU and use the existing screen senders
 * when each on-stage peer also has a usable direct or relayed mesh path.
 */
export function shouldUseSeparateScreenShare(
  hasSfuSession: boolean,
  remoteParticipants: Iterable<Pick<Participant, 'id' | 'status'>>,
  isMeshPeerConnected: (participantId: string) => boolean,
): boolean {
  if (!hasSfuSession) return true;
  for (const participant of remoteParticipants) {
    if (participant.status === 'on-stage' && !isMeshPeerConnected(participant.id)) return false;
  }
  return true;
}

/** A signaling rejoin changes the authenticated SFU identity even at the same stage size. */
export function getSfuSessionParticipantId(input: SfuEligibilityInput): string | null {
  return shouldUseSfuMedia(input) ? input.localParticipant?.id || null : null;
}

/**
 * Prefer each live SFU media kind independently and retain mesh only as a
 * per-track fallback. Returning one combined stream keeps every existing
 * stage, recording, and broadcast consumer unchanged during cutover.
 */
export function mergeSfuMediaWithMeshFallback(
  meshStreams: Map<string, MediaStream>,
  sfuStreams: Map<string, MediaStream>,
  createStream: MediaStreamFactory = (tracks) => new MediaStream(tracks)
): Map<string, MediaStream> {
  const merged = new Map<string, MediaStream>();
  const participantIds = new Set([...meshStreams.keys(), ...sfuStreams.keys()]);

  for (const participantId of participantIds) {
    const meshStream = meshStreams.get(participantId);
    const sfuStream = sfuStreams.get(participantId);
    const sfuVideoTracks = liveTracks(sfuStream?.getVideoTracks() || []);
    const sfuAudioTracks = liveTracks(sfuStream?.getAudioTracks() || []);
    if (!sfuStream || (sfuVideoTracks.length === 0 && sfuAudioTracks.length === 0)) {
      if (meshStream) merged.set(participantId, meshStream);
      continue;
    }
    if (!meshStream) {
      merged.set(participantId, sfuStream);
      continue;
    }

    const meshVideoTracks = liveTracks(meshStream.getVideoTracks());
    const meshAudioTracks = liveTracks(meshStream?.getAudioTracks() || []);
    const selectedVideoTracks = sfuVideoTracks.length > 0 ? sfuVideoTracks : meshVideoTracks;
    const selectedAudioTracks = sfuAudioTracks.length > 0 ? sfuAudioTracks : meshAudioTracks;
    const usesOnlySfu = (selectedVideoTracks.length === 0 || selectedVideoTracks === sfuVideoTracks) &&
      (selectedAudioTracks.length === 0 || selectedAudioTracks === sfuAudioTracks);
    if (usesOnlySfu) {
      merged.set(participantId, sfuStream);
      continue;
    }

    merged.set(participantId, createStream([...selectedVideoTracks, ...selectedAudioTracks]));
  }

  return merged;
}
