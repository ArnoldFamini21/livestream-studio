import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { StateStore } from './stateStore.ts';
import { clampSeekTime, hasKnownDuration } from './mixControls.ts';

type MusicBus = Pick<BroadcastAudioBus, 'getContext' | 'connectNode'>;

export interface BackgroundMusicTrack {
  id: string;
  name: string;
  url: string;
  duration: number;
}

export interface BackgroundMusicState {
  tracks: BackgroundMusicTrack[];
  currentTrackId: string | null;
  isPlaying: boolean;
  /** 0-100, as shown on the slider. */
  volume: number;
  sendToStream: boolean;
  monitorEnabled: boolean;
  loop: boolean;
  fadeEnabled: boolean;
  fadeDuration: number;
  /** Seconds played. Published at most about four times a second. */
  currentTime: number;
  /** Track length in seconds; 0 while unknown (still loading, or a live stream). */
  duration: number;
}

export interface BackgroundMusicPlayerDeps {
  getBus: () => MusicBus | null;
  createAudio?: () => HTMLAudioElement;
  createObjectURL?: (file: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  createId?: () => string;
}

/** Smallest elapsed-time change worth publishing: keeps the time display to a few updates a second. */
const MIN_TIME_STEP_SECONDS = 0.25;

const INITIAL_STATE: BackgroundMusicState = {
  tracks: [],
  currentTrackId: null,
  isPlaying: false,
  volume: 70,
  sendToStream: true,
  monitorEnabled: true,
  loop: false,
  fadeEnabled: false,
  fadeDuration: 2,
  currentTime: 0,
  duration: 0,
};

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
}

/**
 * Background music for the whole studio session. StudioRoom owns it, so the
 * bed keeps playing when its panel closes or another tool panel opens; the
 * panel is only a view of this state. Music is routed through the bus's
 * ducked path, so auto ducking dips it under speech. Fades run on the Web
 * Audio clock, so they also complete in a background tab.
 */
export class BackgroundMusicPlayer extends StateStore<BackgroundMusicState> {
  private audio: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private disconnectRouting: (() => void) | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeGeneration = 0;

  constructor(private readonly deps: BackgroundMusicPlayerDeps) {
    super(INITIAL_STATE);
  }

  setVolume(volume: number): void {
    const next = Math.round(Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : 70)));
    this.setState({ volume: next });
    if (this.fadeTimer === null) this.applyOutputLevel(next / 100);
  }

  setSendToStream(sendToStream: boolean): void {
    this.setState({ sendToStream });
    this.reconnectRouting();
  }

  setMonitorEnabled(monitorEnabled: boolean): void {
    this.setState({ monitorEnabled });
    this.reconnectRouting();
  }

  /**
   * Jump to a time in the current track, playing or paused. This moves the
   * same element that feeds the program mix, so what viewers hear follows.
   */
  seek(seconds: number): void {
    const audio = this.audio;
    if (!audio || !this.state.currentTrackId) return;
    const length = hasKnownDuration(audio.duration) ? audio.duration : this.state.duration;
    const time = clampSeekTime(seconds, length);
    try {
      audio.currentTime = time;
    } catch {
      return;
    }
    this.setState({ currentTime: time });
  }

  setLoop(loop: boolean): void {
    this.setState({ loop });
    if (this.audio) this.audio.loop = loop;
  }

  setFadeEnabled(fadeEnabled: boolean): void {
    this.setState({ fadeEnabled });
  }

  setFadeDuration(fadeDuration: number): void {
    this.setState({ fadeDuration: Math.min(5, Math.max(0, Number.isFinite(fadeDuration) ? fadeDuration : 2)) });
  }

  addFiles(files: Iterable<File>): void {
    const createObjectURL = this.deps.createObjectURL ?? ((file: Blob) => URL.createObjectURL(file));
    for (const file of files) {
      if (!file.type.startsWith('audio/')) continue;
      const url = createObjectURL(file);
      const track: BackgroundMusicTrack = {
        id: this.deps.createId?.() ?? `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name.replace(/\.[^/.]+$/, ''),
        url,
        duration: 0,
      };
      this.setState({ tracks: [...this.state.tracks, track] });
      this.probeDuration(track);
    }
  }

  removeTrack(id: string): void {
    const track = this.state.tracks.find((item) => item.id === id);
    if (!track) return;
    if (id === this.state.currentTrackId) {
      this.cancelFade();
      if (this.audio) {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      }
      this.setState({ isPlaying: false, currentTrackId: null, currentTime: 0, duration: 0 });
    }
    (this.deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url)))(track.url);
    this.setState({ tracks: this.state.tracks.filter((item) => item.id !== id) });
  }

  playTrack(track?: BackgroundMusicTrack): void {
    const audio = this.ensureAudio();
    if (track && track.id !== this.state.currentTrackId) this.loadTrack(track);
    if (!this.state.currentTrackId) return;
    this.ensureRouting();
    this.cancelFade();
    const target = this.state.volume / 100;
    const fadeSeconds = this.state.fadeEnabled ? this.state.fadeDuration : 0;
    if (fadeSeconds > 0) {
      this.applyOutputLevel(0);
      void audio.play().then(() => this.fadeTo(target, fadeSeconds)).catch(() => {
        this.setState({ isPlaying: false });
      });
    } else {
      this.applyOutputLevel(target);
      void audio.play().catch(() => this.setState({ isPlaying: false }));
    }
    this.setState({ isPlaying: true });
  }

  pauseTrack(): void {
    const audio = this.audio;
    if (!audio) return;
    const fadeSeconds = this.state.fadeEnabled ? this.state.fadeDuration : 0;
    if (fadeSeconds > 0 && this.state.isPlaying) {
      this.fadeTo(0, fadeSeconds, () => {
        audio.pause();
        this.setState({ isPlaying: false });
      });
      return;
    }
    this.cancelFade();
    audio.pause();
    this.setState({ isPlaying: false });
  }

  togglePlayPause(): void {
    if (this.state.isPlaying) {
      this.pauseTrack();
      return;
    }
    const current = this.state.tracks.find((track) => track.id === this.state.currentTrackId);
    if (current) this.playTrack();
    else if (this.state.tracks.length > 0) this.playTrack(this.state.tracks[0]);
  }

  skipTrack(direction: 1 | -1): void {
    const { tracks, currentTrackId } = this.state;
    if (tracks.length === 0) return;
    const index = tracks.findIndex((track) => track.id === currentTrackId);
    let next = index + direction;
    if (next < 0) next = tracks.length - 1;
    if (next >= tracks.length) next = 0;
    this.playTrack(tracks[next]);
  }

  /** Stop playback and release every resource (studio unmount). */
  dispose(): void {
    this.cancelFade();
    const audio = this.audio;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    this.disconnectRouting?.();
    this.disconnectRouting = null;
    try {
      this.source?.disconnect();
      this.gain?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.source = null;
    this.gain = null;
    this.context = null;
    this.audio = null;
    const revoke = this.deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
    this.state.tracks.forEach((track) => revoke(track.url));
    this.state = INITIAL_STATE;
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = this.deps.createAudio?.() ?? new Audio();
    audio.preload = 'metadata';
    audio.loop = this.state.loop;
    audio.addEventListener('timeupdate', () => {
      const time = audio.currentTime;
      if (Math.abs(time - this.state.currentTime) < MIN_TIME_STEP_SECONDS) return;
      this.setState({ currentTime: time });
    });
    const publishDuration = () => {
      const known = hasKnownDuration(audio.duration);
      if (known) this.setState({ duration: audio.duration });
      else if (this.audio === audio && !this.state.tracks.some((t) => t.id === this.state.currentTrackId && t.duration > 0)) {
        this.setState({ duration: 0 });
      }
    };
    audio.addEventListener('loadedmetadata', publishDuration);
    audio.addEventListener('durationchange', publishDuration);
    audio.addEventListener('ended', () => {
      if (!audio.loop) this.setState({ isPlaying: false, currentTime: 0 });
    });
    this.audio = audio;
    return audio;
  }

  private loadTrack(track: BackgroundMusicTrack): void {
    const audio = this.ensureAudio();
    this.cancelFade();
    audio.src = track.url;
    audio.load();
    this.setState({ currentTrackId: track.id, currentTime: 0, duration: track.duration || 0 });
  }

  private probeDuration(track: BackgroundMusicTrack): void {
    if (typeof Audio === 'undefined' && !this.deps.createAudio) return;
    const probe = this.deps.createAudio?.() ?? new Audio();
    probe.preload = 'metadata';
    const done = (duration: number) => {
      probe.removeAttribute('src');
      this.setState({
        tracks: this.state.tracks.map((item) => (item.id === track.id ? { ...item, duration } : item)),
      });
    };
    probe.addEventListener('loadedmetadata', () => done(Number.isFinite(probe.duration) ? probe.duration : 0), { once: true });
    probe.addEventListener('error', () => done(0), { once: true });
    probe.src = track.url;
  }

  private ensureRouting(): void {
    const bus = this.deps.getBus();
    const audio = this.audio;
    if (!bus || !audio) return;
    let context: AudioContext;
    try {
      context = bus.getContext();
    } catch {
      return;
    }
    if (this.source && this.context === context) return;
    if (this.source) {
      // The audio session was replaced; an element can only feed one context.
      return;
    }
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    gain.gain.value = this.state.volume / 100;
    source.connect(gain);
    this.context = context;
    this.source = source;
    this.gain = gain;
    audio.volume = 1;
    this.reconnectRouting();
  }

  private reconnectRouting(): void {
    const bus = this.deps.getBus();
    if (!bus || !this.gain) return;
    this.disconnectRouting?.();
    this.disconnectRouting = bus.connectNode(this.gain, {
      stream: this.state.sendToStream,
      monitor: this.state.monitorEnabled,
      duck: true,
    });
  }

  private applyOutputLevel(level: number): void {
    const value = clampUnit(level);
    if (this.gain && this.context) {
      const now = this.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(value, now);
      if (this.audio) this.audio.volume = 1;
      return;
    }
    if (this.audio) this.audio.volume = value;
  }

  private fadeTo(level: number, seconds: number, onComplete?: () => void): void {
    this.cancelFade();
    const target = clampUnit(level);
    const generation = ++this.fadeGeneration;
    if (this.gain && this.context) {
      const now = this.context.currentTime;
      const param = this.gain.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + seconds);
    } else if (this.audio) {
      this.audio.volume = target;
    }
    this.fadeTimer = setTimeout(() => {
      if (generation !== this.fadeGeneration) return;
      this.fadeTimer = null;
      // A volume change during the fade wins once it finishes.
      if (!onComplete) this.applyOutputLevel(this.state.volume / 100);
      onComplete?.();
    }, seconds * 1000);
  }

  private cancelFade(): void {
    this.fadeGeneration += 1;
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
  }
}
