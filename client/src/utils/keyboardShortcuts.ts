export type StudioShortcutCategory = 'Layout' | 'Production';

export interface StudioShortcut {
  id: string;
  key: string; // normalized lowercase key or literal symbol (e.g. '?')
  label: string;
  category: StudioShortcutCategory;
}

export const STUDIO_SHORTCUTS: StudioShortcut[] = [
  { id: 'layout-grid', key: '1', label: 'Grid layout', category: 'Layout' },
  { id: 'layout-spotlight', key: '2', label: 'Spotlight layout', category: 'Layout' },
  { id: 'layout-side-by-side', key: '3', label: 'Side-by-side layout', category: 'Layout' },
  { id: 'layout-pip', key: '4', label: 'Picture-in-picture layout', category: 'Layout' },
  { id: 'layout-single', key: '5', label: 'Solo layout', category: 'Layout' },
  { id: 'toggle-auto-director', key: 'a', label: 'Toggle auto-director', category: 'Production' },
  { id: 'toggle-mic', key: 'm', label: 'Mute / unmute your mic', category: 'Production' },
  { id: 'toggle-camera', key: 'c', label: 'Turn your camera on / off', category: 'Production' },
  { id: 'show-shortcuts', key: '?', label: 'Show keyboard shortcuts', category: 'Production' },
];

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface ShortcutEventTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

// Skip shortcuts while the user is typing into a field or editable surface.
export function shouldIgnoreShortcutTarget(target: ShortcutEventTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function resolveShortcutId(
  event: ShortcutKeyEvent,
  shortcuts: StudioShortcut[] = STUDIO_SHORTCUTS
): string | null {
  // Modifier combos are reserved for the browser/OS; only bare keys are studio shortcuts.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (typeof event.key !== 'string' || event.key.length === 0) return null;
  const normalized = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const match = shortcuts.find((shortcut) => shortcut.key === normalized);
  return match ? match.id : null;
}

export function groupShortcutsByCategory(
  shortcuts: StudioShortcut[] = STUDIO_SHORTCUTS
): Array<{ category: StudioShortcutCategory; shortcuts: StudioShortcut[] }> {
  const order: StudioShortcutCategory[] = ['Layout', 'Production'];
  return order
    .map((category) => ({
      category,
      shortcuts: shortcuts.filter((shortcut) => shortcut.category === category),
    }))
    .filter((group) => group.shortcuts.length > 0);
}
