import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import {
  DEFAULT_SOUND_PAD_VOLUME,
  SOUND_PAD_VOLUMES_STORAGE_KEY,
  clampPadVolume,
  customSoundName,
  formatSoundPadHotkey,
  parsePadVolumes,
  validateCustomSoundDuration,
  validateCustomSoundFile,
} from '../utils/soundBoard.ts';
import type { SoundBoardLibrary, StoredCustomSound } from '../utils/soundBoardLibrary.ts';
import { BUILT_IN_SOUND_EFFECTS, type SoundEffect } from './soundEffects.ts';
import { StateStore } from './stateStore.ts';

type SoundBus = Pick<BroadcastAudioBus, 'getContext' | 'connectNode'>;

export interface CustomSoundSummary {
  id: string;
  name: string;
}

export interface SoundPad {
  id: string;
  name: string;
  icon: string | null;
  color: string;
  kind: 'built-in' | 'custom';
  hotkey: string | null;
}

export interface SoundBoardState {
  volume: number;
  sendToStream: boolean;
  monitorEnabled: boolean;
  padVolumes: Record<string, number>;
  customSounds: CustomSoundSummary[];
  playingIds: string[];
  libraryStatus: 'idle' | 'loading' | 'ready' | 'error';
  message: string | null;
}

interface Voice {
  padId: string;
  gain: GainNode;
  source: AudioScheduledSourceNode | null;
  timer: ReturnType<typeof setTimeout>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SoundBoardPlayerDeps {
  getBus: () => SoundBus;
  library: SoundBoardLibrary;
  storage?: StorageLike | null;
  createId?: () => string;
}

const VOICE_RELEASE_SECONDS = 0.04;

/** Pads in board order: built-in effects, then custom sounds; the first ten get hotkeys. */
export function listSoundPads(
  customSounds: CustomSoundSummary[],
  builtIns: Array<Pick<SoundEffect, 'id' | 'name' | 'icon' | 'color'>> = BUILT_IN_SOUND_EFFECTS
): SoundPad[] {
  const pads: Array<Omit<SoundPad, 'hotkey'>> = [
    ...builtIns.map((effect) => ({ id: effect.id, name: effect.name, icon: effect.icon, color: effect.color, kind: 'built-in' as const })),
    ...customSounds.map((sound) => ({ id: sound.id, name: sound.name, icon: null, color: '#a78bfa', kind: 'custom' as const })),
  ];
  return pads.map((pad, index) => ({ ...pad, hotkey: formatSoundPadHotkey(index) }));
}

function readStorage(storage: StorageLike | null | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The studio's sound board engine. It lives in StudioRoom, so sounds keep
 * playing when the panel closes, pads stay on hotkeys, and custom sounds load
 * from IndexedDB on every visit.
 */
export class SoundBoardPlayer extends StateStore<SoundBoardState> {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private disconnectMaster: (() => void) | null = null;
  private readonly padGains = new Map<string, GainNode>();
  private readonly voices = new Set<Voice>();
  private readonly blobs = new Map<string, Blob>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private libraryLoad: Promise<void> | null = null;

  constructor(private readonly deps: SoundBoardPlayerDeps) {
    super({
      volume: 0.7,
      sendToStream: true,
      monitorEnabled: true,
      padVolumes: parsePadVolumes(readStorage(deps.storage, SOUND_PAD_VOLUMES_STORAGE_KEY)),
      customSounds: [],
      playingIds: [],
      libraryStatus: 'idle',
      message: null,
    });
  }

  get pads(): SoundPad[] {
    return listSoundPads(this.state.customSounds);
  }

  loadLibrary(): Promise<void> {
    if (this.libraryLoad) return this.libraryLoad;
    this.setState({ libraryStatus: 'loading' });
    this.libraryLoad = this.deps.library.list()
      .then((sounds) => {
        for (const sound of sounds) this.blobs.set(sound.id, sound.data);
        this.setState({
          customSounds: sounds.map((sound) => ({ id: sound.id, name: sound.name })),
          libraryStatus: 'ready',
        });
      })
      .catch((error) => {
        console.warn('Custom sounds could not be loaded:', error);
        this.setState({ libraryStatus: 'error', message: 'Saved custom sounds could not be loaded in this browser.' });
      });
    return this.libraryLoad;
  }

  clearMessage(): void {
    this.setState({ message: null });
  }

  playPadAt(index: number): boolean {
    const pad = this.pads[index];
    if (!pad) return false;
    void this.play(pad.id);
    return true;
  }

  async play(padId: string): Promise<void> {
    const effect = BUILT_IN_SOUND_EFFECTS.find((item) => item.id === padId);
    let graph: { context: AudioContext; padGain: GainNode };
    try {
      graph = this.ensurePadGraph(padId);
    } catch (error) {
      console.warn('Sound board audio is unavailable:', error);
      this.setState({ message: 'Sound effects need Web Audio, which this browser blocked.' });
      return;
    }
    const { context, padGain } = graph;

    if (effect) {
      const voiceGain = context.createGain();
      voiceGain.connect(padGain);
      effect.play(context, voiceGain);
      this.addVoice(padId, voiceGain, null, effect.durationSeconds);
      return;
    }

    let buffer: AudioBuffer;
    try {
      buffer = await this.getBuffer(padId, context);
    } catch (error) {
      console.warn('Custom sound could not be decoded:', error);
      this.setState({ message: 'That custom sound could not be played.' });
      return;
    }
    const voiceGain = context.createGain();
    voiceGain.connect(padGain);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(voiceGain);
    source.start();
    this.addVoice(padId, voiceGain, source, buffer.duration);
  }

  /** Stop everything the board is playing, with a short release so nothing clicks. */
  stopAll(): void {
    for (const voice of Array.from(this.voices)) this.endVoice(voice, true);
    this.syncPlaying();
  }

  setVolume(volume: number): void {
    const next = clampPadVolume(volume);
    this.setState({ volume: next });
    if (this.masterGain && this.context) {
      this.masterGain.gain.setTargetAtTime(next, this.context.currentTime, 0.02);
    }
  }

  setPadVolume(padId: string, volume: number): void {
    const next = clampPadVolume(volume);
    const padVolumes = { ...this.state.padVolumes, [padId]: next };
    this.setState({ padVolumes });
    const gain = this.padGains.get(padId);
    if (gain && this.context) gain.gain.setTargetAtTime(next, this.context.currentTime, 0.02);
    try {
      this.deps.storage?.setItem(SOUND_PAD_VOLUMES_STORAGE_KEY, JSON.stringify(padVolumes));
    } catch {
      // Storage full or blocked: the volume still applies for this visit.
    }
  }

  setSendToStream(sendToStream: boolean): void {
    this.setState({ sendToStream });
    this.reconnectMaster();
  }

  setMonitorEnabled(monitorEnabled: boolean): void {
    this.setState({ monitorEnabled });
    this.reconnectMaster();
  }

  async addCustomSound(file: File): Promise<boolean> {
    await this.loadLibrary();
    const invalid = validateCustomSoundFile(file, this.state.customSounds.length);
    if (invalid) {
      this.setState({ message: invalid });
      return false;
    }
    let context: AudioContext;
    try {
      context = this.ensureMaster().context;
    } catch {
      this.setState({ message: 'Sound effects need Web Audio, which this browser blocked.' });
      return false;
    }
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(await file.arrayBuffer());
    } catch {
      this.setState({ message: 'That file could not be read as audio.' });
      return false;
    }
    const tooLong = validateCustomSoundDuration(buffer.duration);
    if (tooLong) {
      this.setState({ message: tooLong });
      return false;
    }

    const record: StoredCustomSound = {
      id: this.deps.createId?.() ?? `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: customSoundName(file.name),
      mimeType: file.type || 'audio/mpeg',
      size: file.size,
      addedAt: new Date().toISOString(),
      data: file,
    };
    let persisted = true;
    try {
      await this.deps.library.put(record);
    } catch (error) {
      persisted = false;
      console.warn('Custom sound could not be saved:', error);
    }
    this.blobs.set(record.id, record.data);
    this.buffers.set(record.id, buffer);
    this.setState({
      customSounds: [...this.state.customSounds, { id: record.id, name: record.name }],
      message: persisted ? null : 'Added for this visit only: this browser would not save it.',
    });
    return true;
  }

  async removeCustomSound(id: string): Promise<void> {
    for (const voice of Array.from(this.voices)) {
      if (voice.padId === id) this.endVoice(voice, true);
    }
    this.syncPlaying();
    this.blobs.delete(id);
    this.buffers.delete(id);
    const padGain = this.padGains.get(id);
    padGain?.disconnect();
    this.padGains.delete(id);
    const { [id]: _removed, ...padVolumes } = this.state.padVolumes;
    this.setState({
      customSounds: this.state.customSounds.filter((sound) => sound.id !== id),
      padVolumes,
    });
    try {
      await this.deps.library.remove(id);
    } catch (error) {
      console.warn('Custom sound could not be removed from storage:', error);
      this.setState({ message: 'Removed for now, but this browser kept a saved copy.' });
    }
  }

  /** Silence and release the audio graph. The next play rebuilds it. */
  dispose(): void {
    for (const voice of Array.from(this.voices)) this.endVoice(voice, false);
    this.voices.clear();
    this.syncPlaying();
    for (const gain of this.padGains.values()) gain.disconnect();
    this.padGains.clear();
    this.disconnectMaster?.();
    this.disconnectMaster = null;
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.context = null;
    this.buffers.clear();
  }

  private ensureMaster(): { context: AudioContext; masterGain: GainNode } {
    const context = this.deps.getBus().getContext();
    if (this.context !== context || !this.masterGain) {
      // A new audio session: earlier nodes belong to a closed context.
      this.disconnectMaster?.();
      this.padGains.clear();
      this.buffers.clear();
      this.context = context;
      this.masterGain = context.createGain();
      this.masterGain.gain.value = this.state.volume;
      this.reconnectMaster();
    }
    return { context, masterGain: this.masterGain };
  }

  private ensurePadGraph(padId: string): { context: AudioContext; padGain: GainNode } {
    const { context, masterGain } = this.ensureMaster();
    let padGain = this.padGains.get(padId);
    if (!padGain) {
      padGain = context.createGain();
      padGain.gain.value = this.state.padVolumes[padId] ?? DEFAULT_SOUND_PAD_VOLUME;
      padGain.connect(masterGain);
      this.padGains.set(padId, padGain);
    }
    return { context, padGain };
  }

  private reconnectMaster(): void {
    if (!this.masterGain) return;
    this.disconnectMaster?.();
    this.disconnectMaster = this.deps.getBus().connectNode(this.masterGain, {
      stream: this.state.sendToStream,
      monitor: this.state.monitorEnabled,
    });
  }

  private async getBuffer(padId: string, context: AudioContext): Promise<AudioBuffer> {
    const cached = this.buffers.get(padId);
    if (cached) return cached;
    const blob = this.blobs.get(padId);
    if (!blob) throw new Error('Unknown sound pad.');
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    this.buffers.set(padId, buffer);
    return buffer;
  }

  private addVoice(padId: string, gain: GainNode, source: AudioScheduledSourceNode | null, durationSeconds: number): void {
    const voice: Voice = {
      padId,
      gain,
      source,
      timer: setTimeout(() => {
        this.endVoice(voice, false);
        this.syncPlaying();
      }, Math.ceil(durationSeconds * 1000) + 150),
    };
    this.voices.add(voice);
    this.syncPlaying();
  }

  private endVoice(voice: Voice, fade: boolean): void {
    if (!this.voices.delete(voice)) return;
    clearTimeout(voice.timer);
    const context = this.context;
    if (fade && context) {
      voice.gain.gain.setTargetAtTime(0, context.currentTime, VOICE_RELEASE_SECONDS / 3);
      setTimeout(() => {
        try {
          voice.source?.stop();
        } catch {
          // Already stopped.
        }
        voice.gain.disconnect();
      }, VOICE_RELEASE_SECONDS * 1000 + 30);
      return;
    }
    try {
      voice.source?.stop();
    } catch {
      // Already stopped.
    }
    voice.gain.disconnect();
  }

  private syncPlaying(): void {
    const playingIds = Array.from(new Set(Array.from(this.voices, (voice) => voice.padId)));
    const current = this.state.playingIds;
    if (playingIds.length === current.length && playingIds.every((id) => current.includes(id))) return;
    this.setState({ playingIds });
  }
}
