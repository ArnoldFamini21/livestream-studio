import { useEffect, useId, useRef, useState } from 'react';
import type { StageBackground } from '@studio/shared';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { getStageBackgroundStyle } from '../utils/stageBackground.ts';
import '../styles/canvas-background.css';

export function CanvasBackgroundControl({ value, onChange }: {
  value: StageBackground;
  onChange: (background: StageBackground) => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="canvas-background-trigger" aria-label="Canvas background" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span className="canvas-background-swatch" style={getStageBackgroundStyle(value)} aria-hidden="true" />
      <span>Background</span>
    </button>
    {open && <CanvasBackgroundDialog value={value} onChange={onChange} onClose={() => setOpen(false)} />}
  </>;
}

function CanvasBackgroundDialog({ value, onChange, onClose }: {
  value: StageBackground;
  onChange: (background: StageBackground) => void;
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
    <footer><span>Saved for this studio in this browser.</span><button type="button" onClick={() => dialogRef.current?.close()}>Done</button></footer>
  </dialog>;
}
