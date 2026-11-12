import { useEffect, useId, useRef, useState } from 'react';
import type { StageBackground } from '@studio/shared';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { getStageBackgroundStyle } from '../utils/stageBackground.ts';
import '../styles/canvas-background.css';

/** Whether everyone in the studio has the host's current background yet. */
export type CanvasBackgroundShareStatus = 'shared' | 'sharing' | 'failed';

const SHARE_STATUS_TEXT: Record<CanvasBackgroundShareStatus, string> = {
  shared: 'Saved for this studio and shown to everyone on stage.',
  sharing: 'Sharing with your guests…',
  failed: 'Could not share this picture, so guests see the default background. Retry, or try another image.',
};

export function CanvasBackgroundControl({ value, onChange, shareStatus = 'shared', onRetryShare }: {
  value: StageBackground;
  onChange: (background: StageBackground) => void;
  shareStatus?: CanvasBackgroundShareStatus;
  onRetryShare?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="canvas-background-trigger" aria-label="Canvas background" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span className="canvas-background-swatch" style={getStageBackgroundStyle(value)} aria-hidden="true" />
      <span>Background</span>
    </button>
    {open && <CanvasBackgroundDialog value={value} onChange={onChange} shareStatus={shareStatus} onRetryShare={onRetryShare} onClose={() => setOpen(false)} />}
  </>;
}

function CanvasBackgroundDialog({ value, onChange, shareStatus, onRetryShare, onClose }: {
  value: StageBackground;
  onChange: (background: StageBackground) => void;
  shareStatus: CanvasBackgroundShareStatus;
  onRetryShare?: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={dialogRef} className="canvas-background-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onClose={onClose} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialogRef.current?.close();
  }}>
    <header>
      <div><h2 id={titleId}>Canvas background</h2><p id={descriptionId}>Behind your slides and cameras. Included in your stream and program recording.</p></div>
      <button type="button" aria-label="Close canvas background" onClick={() => dialogRef.current?.close()}>×</button>
    </header>
    <div className="canvas-background-content"><BackgroundPicker value={value} onChange={onChange} /></div>
    <footer><span role="status" data-share-status={shareStatus}>{SHARE_STATUS_TEXT[shareStatus]}</span>{shareStatus === 'failed' && onRetryShare && <button type="button" onClick={onRetryShare}>Retry</button>}<button type="button" onClick={() => dialogRef.current?.close()}>Done</button></footer>
  </dialog>;
}
