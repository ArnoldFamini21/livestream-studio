import { shouldIgnoreShortcutTarget, type ShortcutEventTarget } from './keyboardShortcuts.ts';

/** Custom pads are short stingers; longer audio belongs in Background Music. */
export const MAX_CUSTOM_SOUND_BYTES = 10 * 1024 * 1024;
export const MAX_CUSTOM_SOUND_SECONDS = 60;
export const MAX_CUSTOM_SOUNDS = 16;
/** Shift+1 ... Shift+9, Shift+0 play the first ten pads. */
export const SOUND_PAD_HOTKEY_COUNT = 10;
export const DEFAULT_SOUND_PAD_VOLUME = 1;
export const SOUND_PAD_VOLUMES_STORAGE_KEY = 'livestream-studio:sound-pad-volumes';

export interface CustomSoundFileInfo {
  name: string;
  size: number;
  type: string;
}

/** Why a file cannot become a pad, or null when it can. */
export function validateCustomSoundFile(file: CustomSoundFileInfo, existingCount: number): string | null {
  if (existingCount >= MAX_CUSTOM_SOUNDS) {
    return `The sound board holds ${MAX_CUSTOM_SOUNDS} custom sounds. Remove one to add another.`;
  }
  if (file.type && !file.type.startsWith('audio/')) return 'Choose an audio file (MP3, WAV, M4A or OGG).';
  if (file.size <= 0) return 'That audio file is empty.';
  if (file.size > MAX_CUSTOM_SOUND_BYTES) {
    return `Sound pads are for short clips (up to ${Math.round(MAX_CUSTOM_SOUND_BYTES / 1024 / 1024)} MB). Use Background Music for longer audio.`;
  }
  return null;
}

export function validateCustomSoundDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'That audio file could not be read.';
  if (seconds > MAX_CUSTOM_SOUND_SECONDS) {
    return `Sound pads are for clips up to ${MAX_CUSTOM_SOUND_SECONDS} seconds. Use Background Music for longer audio.`;
  }
  return null;
}

export function customSoundName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '').trim().slice(0, 60) || 'Sound';
}

export interface SoundPadKeyEvent {
  code?: string;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: ShortcutEventTarget | null;
}

/**
 * The pad (0-based) a key press plays, or null. Pads use Shift + the digit
 * row so they never collide with the bare-digit layout shortcuts, and are
 * read from the physical key so non-US layouts work too.
 */
export function resolveSoundPadHotkey(event: SoundPadKeyEvent): number | null {
  if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  if (shouldIgnoreShortcutTarget(event.target)) return null;
  const match = /^Digit([0-9])$/.exec(event.code ?? '');
  if (!match) return null;
  const digit = Number(match[1]);
  return digit === 0 ? 9 : digit - 1;
}

export function formatSoundPadHotkey(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= SOUND_PAD_HOTKEY_COUNT) return null;
  return `Shift+${index === 9 ? 0 : index + 1}`;
}

export function clampPadVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SOUND_PAD_VOLUME;
  return Math.min(1, Math.max(0, value));
}

export function parsePadVolumes(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const volumes: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) volumes[id] = clampPadVolume(value);
    }
    return volumes;
  } catch {
    return {};
  }
}
