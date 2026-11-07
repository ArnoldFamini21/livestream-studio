export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Where Tab should go inside a dialog: wrap from the last item to the first
 * (and Shift+Tab from the first to the last). Focus outside the dialog
 * (index -1) is pulled back in. Null means let the browser move normally.
 */
export function getWrappedFocusIndex(currentIndex: number, count: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (currentIndex < 0) return backwards ? count - 1 : 0;
  if (backwards && currentIndex === 0) return count - 1;
  if (!backwards && currentIndex === count - 1) return 0;
  return null;
}
