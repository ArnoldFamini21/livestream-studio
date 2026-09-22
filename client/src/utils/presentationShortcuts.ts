import type { PresentationSlideDirection } from './presentationDeckControls.ts';

// Shared by the studio and browser regression fixture: private controls must
// never advance the broadcast through the global keyboard listener.
export function getPresentationShortcut(event: KeyboardEvent): PresentationSlideDirection | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.target instanceof Element) {
    if (event.target.closest('dialog, [role="dialog"], input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null;
    if (event.target.closest('button, summary, a, video, [role="button"]')
      && (event.key === ' ' || !event.target.closest('.presentation-toolbar'))) return null;
  }
  return event.key === 'ArrowLeft' || event.key === 'PageUp' ? 'previous'
    : event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ' ? 'next' : null;
}
