import { mixScreenAudioWithVoice, type MixedScreenAudio } from './screenShareAudio.ts';

type AudioGraphContext = Parameters<typeof mixScreenAudioWithVoice>[0];
type Mixer = typeof mixScreenAudioWithVoice;

/**
 * The SFU audio a presenter publishes while sharing a tab or the system sound:
 * their voice and the shared sound in one track.
 *
 * The voice track can change during the share (a mic switch, a processing
 * toggle, or the first studio sound creating the outbound mix). Publishing the
 * bare voice then would drop the shared sound for everyone on stage, and a mix
 * built once would keep reading the old, stopped mic. trackFor() rebuilds the
 * mix around the new voice instead, so the SFU keeps carrying both.
 */
export class SfuScreenAudioMix {
  private mixed: MixedScreenAudio | null = null;
  private voice: MediaStreamTrack | null = null;
  private disposed = false;

  constructor(
    private readonly context: AudioGraphContext,
    private readonly screenAudio: MediaStreamTrack,
    private readonly mix: Mixer = mixScreenAudioWithVoice,
  ) {}

  /** True while a mixed track is being published. */
  get active(): boolean {
    return !this.disposed && this.mixed !== null;
  }

  /** The track to publish for this voice: the (re)built mix, or the voice alone when mixing is not possible. */
  trackFor(voice: MediaStreamTrack | null): MediaStreamTrack | null {
    if (this.disposed || this.screenAudio.readyState !== 'live') {
      this.release();
      return voice;
    }
    if (this.mixed && this.voice === voice) return this.mixed.track;
    const previous = this.mixed;
    this.mixed = this.mix(this.context, voice, this.screenAudio);
    this.voice = voice;
    previous?.dispose();
    return this.mixed ? this.mixed.track : voice;
  }

  dispose(): void {
    this.disposed = true;
    this.release();
  }

  private release(): void {
    this.mixed?.dispose();
    this.mixed = null;
    this.voice = null;
  }
}
