import type { Participant } from '@studio/shared';
import type { LocalRecordingSource } from '../hooks/useLocalRecording.ts';

interface ScreenPictureInPictureRecordingSourceOptions {
  id: string;
  label: string;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
}

export interface BuildLocalRecordingSourcesOptions {
  localParticipant: Participant;
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  remoteStreams: Map<string, MediaStream>;
  screenStream: MediaStream | null;
  isScreenSharing: boolean;
  programSource?: LocalRecordingSource | null;
  createScreenPictureInPictureSource?: (options: ScreenPictureInPictureRecordingSourceOptions) => LocalRecordingSource | null;
}

export function getRecordingSourceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'track';
}

function liveTracks(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  return tracks.filter((track) => track.readyState === 'live');
}

function createStream(tracks: MediaStreamTrack[]): MediaStream {
  return new MediaStream(tracks);
}

export function buildLocalRecordingSources(options: BuildLocalRecordingSourcesOptions): LocalRecordingSource[] {
  const sources: LocalRecordingSource[] = [];
  if (options.programSource) sources.push(options.programSource);

  const localAudioTracks = liveTracks(options.localStream?.getAudioTracks() || []);
  const localVideoTracks = liveTracks(options.localStream?.getVideoTracks() || []);
  const localId = getRecordingSourceId(options.localParticipant.id);

  if (options.localParticipant.status === 'on-stage' && localAudioTracks.length > 0 && localVideoTracks.length > 0) {
    sources.push({
      id: `${localId}-iso`,
      label: `${options.localParticipant.name} ISO`,
      kind: 'iso',
      stream: createStream([...localVideoTracks, ...localAudioTracks]),
      bitsPerSecond: 8_500_000,
    });
  }

  if (options.localParticipant.status === 'on-stage' && localAudioTracks.length > 0) {
    sources.push({
      id: `${localId}-audio`,
      label: `${options.localParticipant.name} audio`,
      kind: 'audio',
      stream: createStream(localAudioTracks),
      bitsPerSecond: 256_000,
    });
  }

  if (options.localParticipant.status === 'on-stage' && localVideoTracks.length > 0) {
    sources.push({
      id: `${localId}-camera`,
      label: `${options.localParticipant.name} camera`,
      kind: 'video',
      stream: createStream(localVideoTracks),
      bitsPerSecond: 8_000_000,
    });
  }

  for (const [id, participant] of options.participants) {
    if (participant.status !== 'on-stage') continue;
    const remoteStream = options.remoteStreams.get(id);
    if (!remoteStream) continue;
    const remoteId = getRecordingSourceId(id);
    const remoteAudioTracks = liveTracks(remoteStream.getAudioTracks());
    const remoteVideoTracks = liveTracks(remoteStream.getVideoTracks());
    const isRemoteScreen = participant.screenSharing;

    if (!isRemoteScreen && remoteAudioTracks.length > 0 && remoteVideoTracks.length > 0) {
      sources.push({
        id: `${remoteId}-iso`,
        label: `${participant.name} ISO`,
        kind: 'iso',
        stream: createStream([...remoteVideoTracks, ...remoteAudioTracks]),
        bitsPerSecond: 8_500_000,
      });
    }

    if (remoteAudioTracks.length > 0) {
      sources.push({
        id: `${remoteId}-audio`,
        label: `${participant.name} audio`,
        kind: 'audio',
        stream: createStream(remoteAudioTracks),
        bitsPerSecond: 256_000,
      });
    }

    if (remoteVideoTracks.length > 0) {
      sources.push({
        id: `${remoteId}-${isRemoteScreen ? 'screen' : 'camera'}`,
        label: `${participant.name} ${isRemoteScreen ? 'screen' : 'camera'}`,
        kind: isRemoteScreen ? 'screen' : 'video',
        stream: createStream(remoteVideoTracks),
        bitsPerSecond: 8_000_000,
      });
    }
  }

  if (options.isScreenSharing && options.screenStream) {
    const screenVideoTracks = liveTracks(options.screenStream.getVideoTracks());
    const screenAudioTracks = liveTracks(options.screenStream.getAudioTracks());
    if (screenVideoTracks.length > 0) {
      sources.push({
        id: `${localId}-screen`,
        label: `${options.localParticipant.name} screen`,
        kind: 'screen',
        stream: createStream(screenVideoTracks),
        bitsPerSecond: 8_000_000,
      });
      const screenPipSource = options.createScreenPictureInPictureSource?.({
        id: `${localId}-screen-pip`,
        label: `${options.localParticipant.name} screen PiP`,
        screenStream: options.screenStream,
        cameraStream: options.localStream,
      });
      if (screenPipSource) sources.push(screenPipSource);
    }
    if (screenAudioTracks.length > 0) {
      sources.push({
        id: `${localId}-screen-audio`,
        label: `${options.localParticipant.name} screen audio`,
        kind: 'audio',
        stream: createStream(screenAudioTracks),
        bitsPerSecond: 256_000,
      });
    }
  }

  return sources;
}

