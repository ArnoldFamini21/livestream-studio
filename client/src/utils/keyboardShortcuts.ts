export type StudioShortcutCategory = 'You' | 'Production' | 'Layout' | 'Slides' | 'Panels';

export interface StudioShortcut {
  id: string;
  key: string; // normalized lowercase key or literal symbol (e.g. '?')
  label: string;
  category: StudioShortcutCategory;
  /** Needs Shift held: used for actions that affect the broadcast, so a stray key press can't trigger them. */
  shift?: boolean;
  /** Only hosts and co-hosts can use it; guests get the rest. */
  hostOnly?: boolean;
  /** Shown in the help only; another listener handles the key (slide navigation). */
  display?: string;
}

/** Layout keys 1-6 pick the layout in the position shown on the layout bar. */
export const LAYOUT_SHORTCUT_COUNT = 6;

export const STUDIO_SHORTCUTS: StudioShortcut[] = [
  { id: 'toggle-mic', key: 'm', label: 'Mute / unmute your mic', category: 'You' },
  { id: 'toggle-camera', key: 'c', label: 'Turn your camera on / off', category: 'You' },
  { id: 'toggle-screen-share', key: 's', label: 'Share your screen / stop sharing', category: 'You', hostOnly: true },
  { id: 'toggle-recording', key: 'r', shift: true, label: 'Start / stop recording', category: 'Production', hostOnly: true },
  { id: 'open-go-live', key: 'l', shift: true, label: 'Go live (opens destinations)', category: 'Production', hostOnly: true },
  { id: 'admit-all', key: 'a', shift: true, label: 'Admit everyone waiting in the green room', category: 'Production', hostOnly: true },
  { id: 'toggle-auto-director', key: 'a', label: 'Auto-spotlight whoever is speaking', category: 'Production', hostOnly: true },
  { id: 'stop-presenting', key: 'x', label: 'Stop presenting media', category: 'Production', hostOnly: true },
  ...Array.from({ length: LAYOUT_SHORTCUT_COUNT }, (_, index): StudioShortcut => ({
    id: `layout-${index + 1}`,
    key: String(index + 1),
    label: `Layout ${index + 1} on the layout bar`,
    category: 'Layout',
    hostOnly: true,
  })),
  { id: 'slide-next', key: 'ArrowRight', display: '→ / Space', label: 'Next slide', category: 'Slides', hostOnly: true },
  { id: 'slide-previous', key: 'ArrowLeft', display: '←', label: 'Previous slide', category: 'Slides', hostOnly: true },
  { id: 'open-people', key: 'p', label: 'People and green room', category: 'Panels', hostOnly: true },
  { id: 'open-chat', key: 't', label: 'Chat', category: 'Panels', hostOnly: true },
  { id: 'open-media', key: 'f', label: 'Media files', category: 'Panels', hostOnly: true },
  { id: 'open-overlays', key: 'o', label: 'Overlays', category: 'Panels', hostOnly: true },
  { id: 'open-brand', key: 'b', label: 'Brand', category: 'Panels', hostOnly: true },
  { id: 'open-scenes', key: 'n', label: 'Scenes', category: 'Panels', hostOnly: true },
  { id: 'open-invite', key: 'i', label: 'Invite guests', category: 'Panels', hostOnly: true },
  { id: 'show-shortcuts', key: '?', label: 'Show keyboard shortcuts', category: 'Panels' },
];

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
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

export function getShortcutsForRole(isHost: boolean, shortcuts: StudioShortcut[] = STUDIO_SHORTCUTS): StudioShortcut[] {
  return isHost ? shortcuts : shortcuts.filter((shortcut) => !shortcut.hostOnly);
}

export function resolveShortcutId(
  event: ShortcutKeyEvent,
  shortcuts: StudioShortcut[] = STUDIO_SHORTCUTS
): string | null {
  // Ctrl/Cmd/Alt combos belong to the browser and OS; studio shortcuts are bare keys or Shift+letter.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (typeof event.key !== 'string' || event.key.length === 0) return null;
  const isLetter = /^[a-z]$/i.test(event.key);
  const normalized = isLetter ? event.key.toLowerCase() : event.key;
  const match = shortcuts.find((shortcut) => (
    !shortcut.display
    && shortcut.key === normalized
    // Shift is part of how '?' is typed, so only letters distinguish Shift.
    && (!isLetter || Boolean(shortcut.shift) === Boolean(event.shiftKey))
  ));
  return match ? match.id : null;
}

/** The layout slot (0-based) a shortcut id selects, or null. */
export function getLayoutShortcutIndex(shortcutId: string): number | null {
  const match = /^layout-(\d+)$/.exec(shortcutId);
  return match ? Number(match[1]) - 1 : null;
}

export function formatShortcutKey(shortcut: StudioShortcut): string {
  if (shortcut.display) return shortcut.display;
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return shortcut.shift ? `Shift + ${key}` : key;
}

/** Tooltip text with the shortcut appended, e.g. "Mute (M)". */
export function withShortcutHint(label: string, shortcutId: string, shortcuts: StudioShortcut[] = STUDIO_SHORTCUTS): string {
  const shortcut = shortcuts.find((item) => item.id === shortcutId);
  return shortcut ? `${label} (${formatShortcutKey(shortcut)})` : label;
}

export function groupShortcutsByCategory(
  shortcuts: StudioShortcut[] = STUDIO_SHORTCUTS
): Array<{ category: StudioShortcutCategory; shortcuts: StudioShortcut[] }> {
  const order: StudioShortcutCategory[] = ['You', 'Production', 'Layout', 'Slides', 'Panels'];
  return order
    .map((category) => ({
      category,
      shortcuts: shortcuts.filter((shortcut) => shortcut.category === category),
    }))
    .filter((group) => group.shortcuts.length > 0);
}
