import { useEffect, useMemo, useRef, useState } from 'react';
import type { BroadcastOrientation } from '@studio/shared';
import type { ChatOverlayComment } from '../utils/chatOverlayComments.ts';
import {
  chatOverlayFont,
  createChatOverlayLayoutCache,
  getChatOverlayInsetCss,
  type ChatOverlayInsetFlags,
  type ChatOverlayLayoutSettings,
} from '../utils/chatOverlayLayout.ts';
import { getChatOverlayFontRevision, getSharedChatOverlayMeasure } from '../utils/chatOverlayCanvas.ts';
import { getProgramCanvasSize } from '../utils/compositorCanvasSize.ts';

interface ChatOverlayPreviewProps {
  comments: ChatOverlayComment[];
  settings: ChatOverlayLayoutSettings;
  orientation: BroadcastOrientation;
  insetFlags: ChatOverlayInsetFlags;
  fontFamily: string;
  /** Reports the ids of the comments on screen, so Pause can freeze exactly those. */
  onVisibleIdsChange?: (ids: string[]) => void;
}

/**
 * The stage's view of the on-screen chat. It draws the very same layout the
 * compositor draws (one pure function, in output pixels): an SVG whose
 * viewBox is the program canvas, replaying the layout's rectangles and lines.
 * Comment text only ever reaches the DOM as SVG text content, never as markup.
 */
export function ChatOverlayPreview({ comments, settings, orientation, insetFlags, fontFamily, onVisibleIdsChange }: ChatOverlayPreviewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cacheRef = useRef<ReturnType<typeof createChatOverlayLayoutCache> | null>(null);
  cacheRef.current ??= createChatOverlayLayoutCache();
  const [stageHeight, setStageHeight] = useState(0);
  const [fontRevision, setFontRevision] = useState(getChatOverlayFontRevision());
  const canvas = useMemo(() => getProgramCanvasSize(orientation), [orientation]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setStageHeight(svg.clientHeight));
    observer.observe(svg);
    setStageHeight(svg.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.addEventListener) return;
    const onLoaded = () => setFontRevision(getChatOverlayFontRevision());
    document.fonts.addEventListener('loadingdone', onLoaded);
    return () => document.fonts.removeEventListener('loadingdone', onLoaded);
  }, []);

  // Stage CSS px to output px, as the compositor does with its logical scale.
  const scale = stageHeight > 0 ? canvas.height / stageHeight : 1;
  const bottomInset = getChatOverlayInsetCss(insetFlags) * scale;
  const layout = cacheRef.current.get(
    { comments, settings, canvas, bottomInset, fontFamily, measure: getSharedChatOverlayMeasure() },
    String(fontRevision),
  );

  const visibleKey = layout.rows.map((row) => row.id).join('|');
  useEffect(() => { onVisibleIdsChange?.(layout.rows.map((row) => row.id)); }, [visibleKey, onVisibleIdsChange]);

  return (
    <svg
      ref={svgRef}
      className="chat-overlay-preview"
      data-chat-overlay
      data-chat-overlay-rows={layout.rows.length}
      data-chat-overlay-canvas={`${canvas.width}x${canvas.height}`}
      viewBox={`0 0 ${canvas.width} ${canvas.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 8, fontFamily }}
    >
      {layout.primitives.map((item, index) => item.kind === 'rect'
        ? <rect key={index} x={item.x} y={item.y} width={item.width} height={item.height} rx={item.radius} ry={item.radius} fill={item.fill} />
        : <text key={index} x={item.x} y={item.y} fill={item.fill} fontSize={item.fontSize} fontWeight={item.weight} style={{ font: chatOverlayFont(item.weight, item.fontSize, fontFamily) }}>{item.text}</text>)}
      {layout.rows.map((row) => (
        <rect key={`row-${row.id}`} data-chat-overlay-row={row.id} data-question={row.question || undefined} x={row.x} y={row.y} width={row.width} height={row.height} fill="none" />
      ))}
    </svg>
  );
}
