import type { AudioTrackLike, ProgramAudioInput, ProgramAudioMixerChanges } from './programAudioMixer.ts';

export interface ControlledAudioMix<TTrack extends AudioTrackLike> {
  readonly track: TTrack & { clone(): TTrack; stop(): void };
  update(inputs: Iterable<ProgramAudioInput<TTrack>>): ProgramAudioMixerChanges;
  clear(): void;
  dispose(): void;
}

export interface ProgramAudioLease<TTrack> {
  /** A clone of the program track. The holder may stop it; release() does. */
  track: TTrack;
  release: () => void;
}

/**
 * Shares one program mix between its consumers (the live relay, the program
 * recording, a second take...). The graph is built on first use and only
 * listens to its inputs while someone holds a lease; each consumer gets its
 * own clone of the stable output track, so stopping one never silences
 * another.
 */
export class ProgramAudioController<TTrack extends AudioTrackLike & { clone(): TTrack; stop(): void }> {
  private mix: ControlledAudioMix<TTrack> | null = null;
  private leases = 0;
  private generation = 0;

  constructor(
    private readonly createMix: () => ControlledAudioMix<TTrack>,
    private readonly getInputs: () => ProgramAudioInput<TTrack>[]
  ) {}

  get activeLeases(): number {
    return this.leases;
  }

  get built(): boolean {
    return this.mix !== null;
  }

  /** Re-read the inputs and apply them (call whenever membership may have changed). */
  reconcile(): void {
    const mix = this.mix;
    if (!mix) return;
    if (this.leases === 0) {
      mix.clear();
      return;
    }
    mix.update(this.getInputs());
  }

  acquire(): ProgramAudioLease<TTrack> | null {
    if (!this.mix) {
      try {
        this.mix = this.createMix();
      } catch (error) {
        console.warn('Program audio mix is unavailable:', error);
        return null;
      }
    }
    this.leases += 1;
    this.reconcile();
    const track = this.mix.track.clone();
    const generation = this.generation;
    let released = false;
    return {
      track,
      release: () => {
        if (released) return;
        released = true;
        track.stop();
        // A lease from before dispose() no longer counts against a rebuilt mix.
        if (generation !== this.generation) return;
        this.leases = Math.max(0, this.leases - 1);
        this.reconcile();
      },
    };
  }

  /** Tear the graph down. A later acquire() builds a fresh one. */
  dispose(): void {
    this.generation += 1;
    this.leases = 0;
    this.mix?.dispose();
    this.mix = null;
  }
}
