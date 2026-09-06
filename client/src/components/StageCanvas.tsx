import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { fitStageCanvas, STAGE_CANVAS_HEIGHT, STAGE_CANVAS_WIDTH } from '../utils/stageCanvas.ts';

export function StageCanvas({ stageRef, style, children }: {
  stageRef: RefObject<HTMLDivElement>;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = (width: number, height: number) => {
      const next = fitStageCanvas(width, height);
      // Preserve the broadcast geometry while a viewport is temporarily hidden.
      if (next.scale > 0) setScale(current => current === next.scale ? current : next.scale);
    };
    // Measure the untransformed layout box, never a previously scaled frame.
    resize(viewport.clientWidth, viewport.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return <div ref={viewportRef} className="studio-canvasWrapper" style={{ position: 'relative', flex: 1, width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', contain: 'size layout' }}>
    <div ref={stageRef} className="studio-canvas" role="region" aria-label="Broadcast canvas" style={{
      ...style,
      position: 'absolute', left: '50%', top: '50%',
      width: STAGE_CANVAS_WIDTH, height: STAGE_CANVAS_HEIGHT,
      maxWidth: 'none', maxHeight: 'none', boxSizing: 'border-box', border: 0,
      transform: `translate(-50%, -50%) scale(${scale})`, transformOrigin: 'center',
    }}>{children}</div>
  </div>;
}
