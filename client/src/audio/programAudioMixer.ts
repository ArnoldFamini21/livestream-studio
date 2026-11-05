/**
 * Program audio membership and source reconciliation.
 *
 * One long-lived Web Audio graph feeds the live relay and the program
 * recording. Its inputs change while the show runs: guests are promoted to the
 * stage or sent backstage, a host switches microphones or toggles processing
 * (the track id changes), a guest reconnects (new participant id and stream),
 * someone shares a screen with audio. This module keeps the graph in step with
 * those changes. The graph operations sit behind `ProgramAudioGraph`, so the
 * diffing rules are tested in node without Web Audio.
 */

export interface AudioTrackLike {
  id: string;
  readyState: string;
}

export interface AudioStreamLike<TTrack extends AudioTrackLike = AudioTrackLike> {
  getAudioTracks(): TTrack[];
}

export interface ProgramAudioInput<TTrack extends AudioTrackLike = AudioTrackLike> {
  /** Stable identity of the input slot, e.g. `participant:abc#0`. */
  key: string;
  track: TTrack;
  /** Linear gain, clamped to 0..1. */
  gain: number;
}

export interface ProgramAudioGraph<TTrack extends AudioTrackLike, THandle> {
  connectTrack(track: TTrack, gain: number): THandle;
  setGain(handle: THandle, gain: number): void;
  disconnect(handle: THandle): void;
}

export interface ProgramAudioMixerChanges {
  added: string[];
  removed: string[];
  replaced: string[];
  regained: string[];
  failed: string[];
}

interface ConnectedInput<THandle> {
  trackId: string;
  gain: number;
  handle: THandle;
}

export function clampProgramGain(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export class ProgramAudioMixer<TTrack extends AudioTrackLike, THandle> {
  private readonly connected = new Map<string, ConnectedInput<THandle>>();

  constructor(private readonly graph: ProgramAudioGraph<TTrack, THandle>) {}

  get size(): number {
    return this.connected.size;
  }

  keys(): string[] {
    return Array.from(this.connected.keys());
  }

  trackIdFor(key: string): string | null {
    return this.connected.get(key)?.trackId ?? null;
  }

  /**
   * Make the graph match `inputs`: connect new tracks, disconnect inputs that
   * left (or whose track ended), swap the source when a slot's track id
   * changes, and apply gain changes to existing inputs without reconnecting.
   */
  update(inputs: Iterable<ProgramAudioInput<TTrack>>): ProgramAudioMixerChanges {
    const changes: ProgramAudioMixerChanges = { added: [], removed: [], replaced: [], regained: [], failed: [] };
    const desired = new Map<string, ProgramAudioInput<TTrack>>();
    for (const input of inputs) {
      if (!input.key || desired.has(input.key)) continue;
      if (input.track.readyState !== 'live') continue;
      desired.set(input.key, input);
    }

    for (const [key, current] of Array.from(this.connected)) {
      if (desired.has(key)) continue;
      this.safeDisconnect(current.handle);
      this.connected.delete(key);
      changes.removed.push(key);
    }

    for (const [key, input] of desired) {
      const gain = clampProgramGain(input.gain);
      const current = this.connected.get(key);
      if (current && current.trackId === input.track.id) {
        if (current.gain !== gain) {
          this.graph.setGain(current.handle, gain);
          current.gain = gain;
          changes.regained.push(key);
        }
        continue;
      }

      if (current) {
        this.safeDisconnect(current.handle);
        this.connected.delete(key);
      }
      let handle: THandle;
      try {
        handle = this.graph.connectTrack(input.track, gain);
      } catch {
        changes.failed.push(key);
        continue;
      }
      this.connected.set(key, { trackId: input.track.id, gain, handle });
      (current ? changes.replaced : changes.added).push(key);
    }

    return changes;
  }

  /** Disconnect every input. The mixer can be updated again afterwards. */
  clear(): string[] {
    const removed = this.keys();
    for (const current of this.connected.values()) this.safeDisconnect(current.handle);
    this.connected.clear();
    return removed;
  }

  private safeDisconnect(handle: THandle): void {
    try {
      this.graph.disconnect(handle);
    } catch {
      // The node was already disconnected or its context has closed.
    }
  }
}

export type ProgramStageStatus = 'green-room' | 'backstage' | 'on-stage' | string;

export interface ProgramAudioMembershipState<TTrack extends AudioTrackLike = AudioTrackLike> {
  localParticipant: { id: string; status: ProgramStageStatus } | null;
  /** The host's own microphone stream (mic only, never the outbound mix). */
  localStream: AudioStreamLike<TTrack> | null;
  participants: Iterable<[string, { status: ProgramStageStatus }]>;
  remoteStreams: ReadonlyMap<string, AudioStreamLike<TTrack>>;
  /** Screen shares that arrive beside a participant's camera stream. */
  remoteScreenStreams?: ReadonlyMap<string, AudioStreamLike<TTrack>>;
  /** The local screen share (tab or system audio). */
  localScreenStream?: AudioStreamLike<TTrack> | null;
  participantVolumes: Record<string, number>;
}

function liveAudioTracks<TTrack extends AudioTrackLike>(stream: AudioStreamLike<TTrack> | null | undefined): TTrack[] {
  if (!stream) return [];
  return stream.getAudioTracks().filter((track) => track.readyState === 'live');
}

/**
 * The inputs the program mix should hear right now. Only on-stage people are
 * audible on air; backstage and green-room audio never reaches the program.
 * A track is only mixed once even if two streams carry it.
 */
export function buildProgramAudioInputs<TTrack extends AudioTrackLike>(
  state: ProgramAudioMembershipState<TTrack>
): ProgramAudioInput<TTrack>[] {
  const inputs: ProgramAudioInput<TTrack>[] = [];
  const seenTrackIds = new Set<string>();
  const push = (keyPrefix: string, stream: AudioStreamLike<TTrack> | null | undefined, gain: number) => {
    liveAudioTracks(stream).forEach((track, index) => {
      if (seenTrackIds.has(track.id)) return;
      seenTrackIds.add(track.id);
      inputs.push({ key: `${keyPrefix}#${index}`, track, gain: clampProgramGain(gain) });
    });
  };

  const local = state.localParticipant;
  if (local && local.status === 'on-stage') {
    push(`participant:${local.id}`, state.localStream, state.participantVolumes[local.id] ?? 1);
  }

  const onStageIds: string[] = [];
  for (const [id, participant] of state.participants) {
    if (participant.status !== 'on-stage') continue;
    if (local && id === local.id) continue;
    onStageIds.push(id);
    push(`participant:${id}`, state.remoteStreams.get(id), state.participantVolumes[id] ?? 1);
  }

  for (const id of onStageIds) {
    push(`screen:${id}`, state.remoteScreenStreams?.get(id), 1);
  }

  push('screen:local', state.localScreenStream, 1);
  return inputs;
}
