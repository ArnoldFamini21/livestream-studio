import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { fitStageCanvas, STAGE_CANVAS_HEIGHT, STAGE_CANVAS_WIDTH } from '../utils/stageCanvas.ts';

export function StageCanvas({ stageRef, style, children, footer }: {
  stageRef: RefObject<HTMLDivElement>;
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
      const next = fitStageCanvas(width, Math.max(0, height - footerHeight));
      // Preserve the broadcast geometry while a viewport is temporarily hidden.
      if (next.scale > 0) setFrame(current => current.scale === next.scale ? current : next);
    };
    // Measure the untransformed layout box, never a previously scaled frame.
    resize(viewport.clientWidth, viewport.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [footerHeight]);

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
      <div ref={stageRef} className="studio-canvas" role="region" aria-label="Broadcast canvas" style={{
        ...style,
        position: 'absolute', left: 0, top: 0,
        width: STAGE_CANVAS_WIDTH, minWidth: STAGE_CANVAS_WIDTH, maxWidth: STAGE_CANVAS_WIDTH,
        height: STAGE_CANVAS_HEIGHT, minHeight: STAGE_CANVAS_HEIGHT, maxHeight: STAGE_CANVAS_HEIGHT,
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
