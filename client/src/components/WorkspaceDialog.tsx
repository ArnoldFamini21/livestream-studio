import { useEffect, useRef, type ReactNode } from 'react';
import { StudioIcon } from './StudioIcon.tsx';

/** Native dialog supplies keyboard focus containment, Escape, and focus restoration. */
export function WorkspaceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="workspace-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <button className="dialog-close" aria-label="Close dialog" onClick={onClose}><StudioIcon name="close" /></button>
    {children}
  </dialog>;
}
