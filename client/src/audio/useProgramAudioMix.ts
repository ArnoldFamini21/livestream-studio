import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Participant } from '@studio/shared';
import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import {
  INITIAL_MUSIC_DUCKING_STATE,
  getMusicDuckingReleaseDelay,
  isSpeechPresent,
  nextMusicDuckingState,
} from '../utils/audioDucking.ts';
import { createLiveAudioMix, type LiveAudioMix } from './liveAudioMix.ts';
import { ProgramAudioController, type ProgramAudioLease } from './programAudioController.ts';
import { buildProgramAudioInputs, type LocalProgramPresence, type ProgramAudioMembershipState } from './programAudioMixer.ts';

export type ProgramAudioTrackLease = ProgramAudioLease<MediaStreamTrack>;

/**
 * Bumps when a stream gains or loses a track, or one of its audio tracks
 * ends, so membership is re-read even when the stream object stays the same
 * (WebRTC adds a renegotiated track to the existing remote stream).
 */
export function useAudioTrackVersion(streams: Array<MediaStream | null | undefined>): number {
  const [version, setVersion] = useState(0);
  const key = streams.map((stream) => stream?.id ?? '').join('|');
  const streamsRef = useRef(streams);
  streamsRef.current = streams;

  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    const cleanups: Array<() => void> = [];
    const watchTrack = (track: MediaStreamTrack) => {
      track.addEventListener('ended', bump);
      cleanups.push(() => track.removeEventListener('ended', bump));
    };
    for (const stream of streamsRef.current) {
      if (!stream) continue;
      const onAddTrack = (event: MediaStreamTrackEvent) => {
        if (event.track.kind === 'audio') watchTrack(event.track);
        bump();
      };
      stream.addEventListener('addtrack', onAddTrack);
      stream.addEventListener('removetrack', bump);
      cleanups.push(() => {
        stream.removeEventListener('addtrack', onAddTrack);
        stream.removeEventListener('removetrack', bump);
      });
      stream.getAudioTracks().forEach(watchTrack);
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [key]);

  return version;
}

export interface UseProgramAudioMixOptions {
  bus: BroadcastAudioBus;
  localParticipant: Participant | null;
  /** The host's microphone stream (never the outbound mix, which already carries the bus). */
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  remoteStreams: Map<string, MediaStream>;
  remoteScreenStreams: Map<string, MediaStream>;
  screenStream: MediaStream | null;
  participantVolumes: Record<string, number>;
  /** Which local tiles the compositor puts on the program (getLocalProgramPresence). */
  localPresence?: LocalProgramPresence;
}

export interface ProgramAudioMix {
  /** A clone of the live program track; release it when the consumer stops. */
  acquire: () => ProgramAudioTrackLease | null;
}

/**
 * The single program audio graph shared by the live relay and the program
 * recording. Inputs follow the stage live: guests promoted after Go Live,
 * microphone switches, processing toggles, reconnects and screen audio all
 * reach the output track, and per-person volume applies while recording.
 */
export function useProgramAudioMix(options: UseProgramAudioMixOptions): ProgramAudioMix {
  const stateRef = useRef<ProgramAudioMembershipState<MediaStreamTrack>>({
    localParticipant: null,
    localStream: null,
    participants: [],
    remoteStreams: new Map(),
    participantVolumes: {},
  });
  stateRef.current = {
    localParticipant: options.localParticipant,
    localStream: options.localStream,
    participants: options.participants,
    remoteStreams: options.remoteStreams,
    remoteScreenStreams: options.remoteScreenStreams,
    localScreenStream: options.screenStream,
    participantVolumes: options.participantVolumes,
    ...(options.localPresence ? { localPresence: options.localPresence } : {}),
  };
  const busRef = useRef(options.bus);
  busRef.current = options.bus;

  const controllerRef = useRef<ProgramAudioController<MediaStreamTrack> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ProgramAudioController<MediaStreamTrack>(
      () => createLiveAudioMix(busRef.current),
      () => buildProgramAudioInputs(stateRef.current)
    );
  }

  const trackVersion = useAudioTrackVersion([
    options.localStream,
    options.screenStream,
    ...options.remoteStreams.values(),
    ...options.remoteScreenStreams.values(),
  ]);

  useEffect(() => {
    controllerRef.current?.reconcile();
  }, [
    options.localParticipant?.id,
    options.localParticipant?.status,
    options.localStream,
    options.participants,
    options.remoteStreams,
    options.remoteScreenStreams,
    options.screenStream,
    options.participantVolumes,
    options.localPresence?.camera,
    options.localPresence?.screen,
    trackVersion,
  ]);

  useEffect(() => () => {
    controllerRef.current?.dispose();
  }, []);

  const acquire = useCallback(() => controllerRef.current?.acquire() ?? null, []);
  return useMemo(() => ({ acquire }), [acquire]);
}

/**
 * The host's outbound audio to guests: processed mic plus the media bus, so
 * guests hear sound effects, music and clips. Muting the mic disables only the
 * mic track (its source goes silent); the bus keeps playing for guests. Built
 * only once the bus has been used, so a studio without effects keeps sending
 * the plain mic track. Returns null when Web Audio is unavailable.
 */
export function useOutboundAudioMix({
  bus,
  micStream,
  enabled,
}: {
  bus: BroadcastAudioBus;
  micStream: MediaStream | null;
  enabled: boolean;
}): MediaStreamTrack | null {
  const mixRef = useRef<LiveAudioMix | null>(null);
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const trackVersion = useAudioTrackVersion([micStream]);

  useEffect(() => {
    if (!enabled || mixRef.current) return;
    try {
      mixRef.current = createLiveAudioMix(bus);
      setTrack(mixRef.current.track);
    } catch (error) {
      console.warn('Guests will not hear studio sounds; the outbound mix failed:', error);
    }
  }, [bus, enabled]);

  useEffect(() => {
    const mix = mixRef.current;
    if (!mix) return;
    mix.update((micStream?.getAudioTracks() ?? []).map((micTrack, index) => ({
      key: `mic#${index}`,
      track: micTrack,
      gain: 1,
    })));
  }, [micStream, track, trackVersion]);

  useEffect(() => () => {
    mixRef.current?.dispose();
    mixRef.current = null;
  }, []);

  return track;
}

/** The stream handed to WebRTC: camera video plus the outbound audio mix. */
export function buildPeerLocalStream(
  localStream: MediaStream | null,
  outboundAudioTrack: MediaStreamTrack | null
): MediaStream | null {
  if (!outboundAudioTrack) return localStream;
  return new MediaStream([...(localStream?.getVideoTracks() ?? []), outboundAudioTrack]);
}

/**
 * Auto ducking: lower music and clip audio while anyone on stage speaks, with
 * a short hold so the bed does not pump between words.
 */
export function useMusicDucking({
  bus,
  enabled,
  participantAudioLevels,
  onStageIds,
}: {
  bus: Pick<BroadcastAudioBus, 'setMusicDucked'>;
  enabled: boolean;
  participantAudioLevels: Record<string, number>;
  onStageIds: string[];
}): void {
  const stateRef = useRef(INITIAL_MUSIC_DUCKING_STATE);
  const releaseTimerRef = useRef<number | null>(null);
  const speaking = enabled && isSpeechPresent(participantAudioLevels, onStageIds);
  const { setMusicDucked } = bus;

  useEffect(() => {
    const apply = () => {
      const now = Date.now();
      stateRef.current = nextMusicDuckingState(stateRef.current, { enabled, speaking, now });
      setMusicDucked(stateRef.current.ducked);
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      const delay = speaking ? null : getMusicDuckingReleaseDelay(stateRef.current, now);
      if (delay !== null) {
        releaseTimerRef.current = window.setTimeout(() => {
          releaseTimerRef.current = null;
          apply();
        }, delay + 10);
      }
    };
    apply();
  }, [enabled, setMusicDucked, speaking]);

  useEffect(() => () => {
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
  }, []);
}
