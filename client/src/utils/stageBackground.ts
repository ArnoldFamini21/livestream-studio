import type { CSSProperties } from 'react';
import type { StageBackground } from '@studio/shared';

/** Accept an explicit RGB hex color; normalize short notation for the native picker. */
export function normalizeBackgroundColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(color)) return color;
  if (/^#[\da-f]{3}$/.test(color)) return `#${[...color.slice(1)].map(character => character.repeat(2)).join('')}`;
  return null;
}

export function getPersistableStageBackground(background: StageBackground): StageBackground {
  if ((background.type === 'image' || background.type === 'video') && background.value.startsWith('blob:')) {
    return { type: 'none', value: '' };
  }
  return background;
}

/** The preview's canvas uses the same background value as the program compositor. */
export function getStageBackgroundStyle(background: StageBackground): CSSProperties {
  switch (background.type) {
    case 'color':
    case 'gradient':
      return { background: background.value };
    case 'image':
      return { backgroundImage: `url(${background.value})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' };
    default:
      return {};
  }
}
