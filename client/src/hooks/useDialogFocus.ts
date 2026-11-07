import { useEffect, useRef, type RefObject } from 'react';
import { FOCUSABLE_SELECTOR, getWrappedFocusIndex } from '../utils/focusTrap.ts';

/**
 * Modal focus handling for overlay dialogs that are not native <dialog>s:
 * move focus inside on open, keep Tab/Shift+Tab inside, close on Escape, and
 * give focus back to whatever opened the dialog when it closes.
 */
export function useDialogFocus(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
    const initial = initialFocusRef?.current || focusables()[0] || container;
    if (initial === container && !container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = getWrappedFocusIndex(current, items.length, event.shiftKey);
      if (next !== null) {
        event.preventDefault();
        items[next].focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Give focus back only if it is still inside the dialog (or lost), never steal it from elsewhere.
      const active = document.activeElement;
      if (previousFocus && previousFocus.isConnected && (!active || active === document.body || container.contains(active))) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [containerRef, initialFocusRef]);
}
