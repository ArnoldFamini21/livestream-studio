import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { BroadcastOrientation } from '@studio/shared';
import { fitStageCanvas, getStageCanvasSize } from '../utils/stageCanvas.ts';

export function StageCanvas({ stageRef, style, children, footer, orientation = 'landscape' }: {
  stageRef: RefObject<HTMLDivElement>;
  /** Portrait output lays the stage out at 9:16 so DOM rects map onto 1080x1920. */
  orientation?: BroadcastOrientation;
  style?: CSSProperties;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(() => fitStageCanvas(0, 0));
  const footerHeight = footer ? 48 : 0;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = (width: number, height: number) => {
      const next = fitStageCanvas(width, Math.max(0, height - footerHeight), orientation);
      // Preserve the broadcast geometry while a viewport is temporarily hidden.
      if (next.scale > 0) setFrame(current => current.scale === next.scale && current.width === next.width ? current : next);
    };
    // Measure the untransformed layout box, never a previously scaled frame.
    resize(viewport.clientWidth, viewport.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [footerHeight, orientation]);
  const stage = getStageCanvasSize(orientation);

  return <div ref={viewportRef} className="studio-canvasWrapper" style={{ position: 'relative', flex: '1 1 0px', width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', contain: 'size layout' }}>
    {/* Position the fitted preview separately from the broadcast surface.
        Only uniform scaling may change its appearance; the surface itself
        always keeps the same logical dimensions for the compositor. */}
    <div className="studio-preview-frame" style={{
      position: 'absolute', left: '50%',
      top: `calc(50% - ${footerHeight / 2}px)`,
      width: frame.width, height: frame.height,
      transform: 'translate(-50%, -50%)',
      visibility: frame.scale > 0 ? 'visible' : 'hidden',
      contain: 'size layout',
    }}>
      <div ref={stageRef} className="studio-canvas" role="region" aria-label="Broadcast canvas" data-stage-orientation={orientation} style={{
        ...style,
        position: 'absolute', left: 0, top: 0,
        width: stage.width, minWidth: stage.width, maxWidth: stage.width,
        height: stage.height, minHeight: stage.height, maxHeight: stage.height,
        boxSizing: 'border-box', border: 0, margin: 0, padding: 0,
        transform: `scale(${frame.scale})`, transformOrigin: 'top left',
        transition: 'none', animation: 'none',
      }}>{children}</div>
      {footer && <div className="studio-canvas-footer" style={{
        position: 'absolute', left: 0, top: '100%', width: '100%', height: footerHeight,
      }}>{footer}</div>}
    </div>
  </div>;
}
