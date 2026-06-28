import { useEffect, useRef, useCallback } from 'react';
import { CHAT_REACTION_EMOJIS, type ActiveMedia, type LivePoll, type LogoPlacement, type LogoSize, type QAQuestion, type StageBackground } from '@studio/shared';
import type { BannerData } from '../components/BannerOverlay.tsx';
import type { HighlightedComment } from '../components/CommentHighlight.tsx';
import type { LowerThirdData } from '../components/LowerThird.tsx';
import { REACTION_OVERLAY_DURATION_MS, type FloatingReaction } from '../components/ReactionOverlay.tsx';
import type { TimerData } from '../components/TimerOverlay.tsx';
import type { TickerData } from '../components/TickerOverlay.tsx';
import { normalizeLowerThirdAccentColor } from '../utils/lowerThirds.ts';
import { DEFAULT_LOGO_OPACITY, normalizeLogoOpacity } from '../utils/logoWatermark.ts';
import type { ActiveStreamScreen } from '../utils/streamScreens.ts';
import type { LiveCaptionSegment } from './useLiveCaptions.ts';

interface CompositorProps {
  containerRef: React.RefObject<HTMLDivElement>;
  isLive: boolean;
  banners: BannerData[];
  lowerThirds: LowerThirdData[];
  timers: TimerData[];
  tickers: TickerData[];
  activeMedia?: ActiveMedia | null;
  highlightedComment?: HighlightedComment | null;
  highlightedQA?: QAQuestion | null;
  highlightedPoll?: LivePoll | null;
  floatingReactions?: FloatingReaction[];
  caption?: LiveCaptionSegment | null;
  stageBackground?: StageBackground;
  brandColor?: string;
  logoUrl?: string | null;
  logoPlacement?: LogoPlacement;
  logoSize?: LogoSize;
  logoOpacity?: number;
  streamScreen?: ActiveStreamScreen | null;
}

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#2563eb',
];

function truncateCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '...';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}${ellipsis}`;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let line = '';

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const candidate = line ? `${line} ${word}` : word;

    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) {
      lines.push(line);
      line = word;
    } else {
      lines.push(truncateCanvasText(ctx, word, maxWidth));
      line = '';
    }

    if (lines.length === maxLines) {
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = truncateCanvasText(ctx, `${last} ...`, maxWidth);
      return lines;
    }
  }

  if (line && lines.length < maxLines) {
    lines.push(truncateCanvasText(ctx, line, maxWidth));
  }

  return lines;
}

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function splitGradientParts(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseGradientColorStop(part: string): { color: string; offset?: number } {
  const pieces = part.split(/\s+/).filter(Boolean);
  if (pieces.length < 2) return { color: part };

  const stop = pieces[pieces.length - 1];
  const color = pieces.slice(0, -1).join(' ');
  if (stop.endsWith('%')) {
    const percent = Number(stop.slice(0, -1));
    if (Number.isFinite(percent)) return { color, offset: Math.min(1, Math.max(0, percent / 100)) };
  }

  return { color: part };
}

function createCanvasGradient(
  ctx: CanvasRenderingContext2D,
  value: string,
  width: number,
  height: number
): CanvasGradient | null {
  const match = value.match(/^linear-gradient\((.*)\)$/i);
  if (!match) return null;

  const parts = splitGradientParts(match[1]);
  if (parts.length < 2) return null;

  let angle = 180;
  let stopParts = parts;
  const first = parts[0].toLowerCase();
  if (first.endsWith('deg')) {
    const parsed = Number(first.replace('deg', '').trim());
    if (Number.isFinite(parsed)) {
      angle = parsed;
      stopParts = parts.slice(1);
    }
  }
  if (stopParts.length < 2) return null;

  const radians = ((angle - 90) * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const half = Math.max(width, height);
  const gradient = ctx.createLinearGradient(
    width / 2 - dx * half,
    height / 2 - dy * half,
    width / 2 + dx * half,
    height / 2 + dy * half
  );

  const stops = stopParts.map(parseGradientColorStop);
  stops.forEach((stop, index) => {
    const offset = stop.offset ?? (stops.length === 1 ? 0 : index / (stops.length - 1));
    gradient.addColorStop(offset, stop.color);
  });

  return gradient;
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number
) {
  const imageRatio = image.width / image.height;
  const canvasRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.width;
  let sourceHeight = image.height;

  if (imageRatio > canvasRatio) {
    sourceWidth = image.height * canvasRatio;
    sourceX = (image.width - sourceWidth) / 2;
  } else {
    sourceHeight = image.width / canvasRatio;
    sourceY = (image.height - sourceHeight) / 2;
  }

  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
}

function drawStageBackground(
  ctx: CanvasRenderingContext2D,
  background: StageBackground | undefined,
  backgroundImage: HTMLImageElement | null
) {
  const width = 1920;
  const height = 1080;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  if (!background || background.type === 'none' || !background.value) return;

  if (background.type === 'color') {
    ctx.fillStyle = background.value;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (background.type === 'gradient') {
    const gradient = createCanvasGradient(ctx, background.value, width, height);
    if (gradient) {
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  if (background.type === 'image' && backgroundImage?.complete && backgroundImage.naturalWidth > 0) {
    drawCoverImage(ctx, backgroundImage, width, height);
  }
}

function getLogoCssMaxSize(size: LogoSize): { maxWidth: number; maxHeight: number } {
  switch (size) {
    case 'small':
      return { maxWidth: 84, maxHeight: 28 };
    case 'large':
      return { maxWidth: 180, maxHeight: 58 };
    case 'medium':
    default:
      return { maxWidth: 128, maxHeight: 42 };
  }
}

function getLogoCanvasRect(
  image: HTMLImageElement,
  placement: LogoPlacement,
  size: LogoSize,
  scaleX: number,
  scaleY: number
): { x: number; y: number; width: number; height: number } | null {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const { maxWidth, maxHeight } = getLogoCssMaxSize(size);
  const cssScale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * cssScale * scaleX;
  const height = sourceHeight * cssScale * scaleY;
  const marginX = 12 * scaleX;
  const marginY = 12 * scaleY;

  return {
    x: placement.endsWith('right') ? 1920 - marginX - width : marginX,
    y: placement.startsWith('bottom') ? 1080 - marginY - height : marginY,
    width,
    height,
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function getScaledNodeRect(
  node: Element | null,
  containerBounds: DOMRect,
  scaleX: number,
  scaleY: number
) {
  if (!node) {
    return { x: 8, y: 8, width: 1904, height: 1064 };
  }

  const rect = node.getBoundingClientRect();
  return {
    x: (rect.left - containerBounds.left) * scaleX,
    y: (rect.top - containerBounds.top) * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function drawContainedSource(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number
) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || width <= 0 || height <= 0) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  const dx = x + (width - drawnWidth) / 2;
  const dy = y + (height - drawnHeight) / 2;
  ctx.drawImage(source, dx, dy, drawnWidth, drawnHeight);
}

function isSameOriginOrLocalMediaUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('blob:') || url.startsWith('data:')) return true;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function drawMediaFallbackCard(
  ctx: CanvasRenderingContext2D,
  media: ActiveMedia,
  x: number,
  y: number,
  width: number,
  height: number,
  brandColor: string,
  label = 'Shared media'
) {
  const cardWidth = Math.min(760, width * 0.72);
  const cardHeight = Math.min(380, height * 0.62);
  const cardX = x + (width - cardWidth) / 2;
  const cardY = y + (height - cardHeight) / 2;

  ctx.save();
  const gradient = ctx.createLinearGradient(cardX, cardY, cardX + cardWidth, cardY + cardHeight);
  gradient.addColorStop(0, 'rgba(17, 24, 39, 0.96)');
  gradient.addColorStop(1, 'rgba(49, 46, 129, 0.9)');
  ctx.fillStyle = gradient;
  drawRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 24);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 24);
  ctx.stroke();

  const iconSize = 96;
  const iconX = cardX + (cardWidth - iconSize) / 2;
  const iconY = cardY + 62;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  drawRoundedRect(ctx, iconX, iconY, iconSize, iconSize, 22);
  ctx.strokeStyle = brandColor;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.rect(iconX + 24, iconY + 26, iconSize - 48, iconSize - 42);
  ctx.moveTo(iconX + 36, iconY + iconSize - 22);
  ctx.lineTo(iconX + iconSize - 36, iconY + iconSize - 22);
  ctx.moveTo(iconX + iconSize / 2, iconY + iconSize - 42);
  ctx.lineTo(iconX + iconSize / 2, iconY + iconSize - 22);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = 'white';
  ctx.font = '800 36px Inter, Arial, sans-serif';
  const titleLines = wrapCanvasText(ctx, media.name, cardWidth - 96, 2);
  titleLines.forEach((line, index) => {
    ctx.fillText(line, cardX + cardWidth / 2, iconY + iconSize + 58 + index * 42);
  });

  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.font = '800 20px Inter, Arial, sans-serif';
  ctx.fillText(label.toUpperCase(), cardX + cardWidth / 2, cardY + cardHeight - 54);
  ctx.restore();
}

function drawActiveMediaOverlay(
  ctx: CanvasRenderingContext2D,
  media: ActiveMedia,
  mediaNode: Element | null,
  containerBounds: DOMRect,
  scaleX: number,
  scaleY: number,
  image: HTMLImageElement | null,
  brandColor: string
) {
  const rect = getScaledNodeRect(mediaNode, containerBounds, scaleX, scaleY);
  const radius = Math.max(12, 16 * Math.min(scaleX, scaleY));
  const padding = 20;
  const contentX = rect.x + padding;
  const contentY = rect.y + padding;
  const contentW = Math.max(0, rect.width - padding * 2);
  const contentH = Math.max(0, rect.height - padding * 2);

  ctx.save();
  ctx.fillStyle = '#000';
  drawRoundedRect(ctx, rect.x, rect.y, rect.width, rect.height, radius);

  if (media.type === 'image' && image?.complete && image.naturalWidth > 0) {
    drawContainedSource(ctx, image, image.naturalWidth, image.naturalHeight, contentX, contentY, contentW, contentH);
    ctx.restore();
    return;
  }

  if (media.type === 'video' && isSameOriginOrLocalMediaUrl(media.url)) {
    const video = mediaNode?.querySelector('video');
    if (video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth > 0) {
      try {
        drawContainedSource(ctx, video, video.videoWidth, video.videoHeight, contentX, contentY, contentW, contentH);
        ctx.restore();
        return;
      } catch {
        // Fall through to a safe card instead of risking a broken compositor.
      }
    }
  }

  const label = media.type === 'presentation'
    ? 'Presentation deck'
    : media.type === 'pdf'
      ? 'PDF shared'
      : media.type === 'video'
        ? 'Video media'
        : media.type === 'image'
          ? 'Image media'
          : 'Shared file';
  drawMediaFallbackCard(ctx, media, rect.x, rect.y, rect.width, rect.height, brandColor, label);
  ctx.restore();
}

function formatTimerTime(totalSeconds: number): string {
  const m = Math.floor(Math.abs(totalSeconds) / 60);
  const s = Math.abs(totalSeconds) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function drawBroadcastTimer(
  ctx: CanvasRenderingContext2D,
  timer: TimerData,
  brandColor: string,
  options: { hasBanner: boolean; hasTicker: boolean; hasLowerThird: boolean }
) {
  if (!timer.visible) return;

  const isFinished = timer.mode === 'countdown' && timer.remainingSeconds <= 0 && !timer.isRunning;
  const isUrgent = timer.mode === 'countdown' && timer.remainingSeconds <= 10 && timer.remainingSeconds > 0;
  const urgentColor = isFinished ? '#ef4444' : isUrgent ? '#f97316' : null;
  const text = formatTimerTime(timer.remainingSeconds);

  const timeFont = timer.style === 'bold'
    ? '800 60px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
    : timer.style === 'neon'
      ? '700 54px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
      : '700 48px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
  const paddingX = timer.style === 'bold' ? 34 : 28;
  const paddingY = timer.style === 'bold' ? 22 : 18;
  const labelHeight = isFinished ? 24 : 0;

  ctx.save();
  ctx.font = timeFont;
  const width = Math.max(174, Math.ceil(ctx.measureText(text).width + paddingX * 2));
  const height = paddingY * 2 + (timer.style === 'bold' ? 60 : 54) + labelHeight;
  const margin = 44;
  const bottomReserve = Math.max(
    0,
    options.hasTicker ? 74 : 0,
    options.hasBanner ? 184 : 0,
    options.hasLowerThird && timer.position === 'bottom-left' ? 126 : 0
  );
  const x = timer.position.endsWith('right') ? 1920 - margin - width : margin;
  const y = timer.position.startsWith('bottom') ? 1080 - margin - bottomReserve - height : margin;

  if (timer.style === 'bold') {
    ctx.shadowColor = urgentColor ? `${urgentColor}66` : 'rgba(99, 102, 241, 0.4)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = urgentColor || brandColor;
    drawRoundedRect(ctx, x, y, width, height, 18);
  } else if (timer.style === 'neon') {
    ctx.shadowColor = urgentColor || '#22d3ee';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
    drawRoundedRect(ctx, x, y, width, height, 16);
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = urgentColor || '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.stroke();
  } else {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.64)';
    drawRoundedRect(ctx, x, y, width, height, 14);
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = urgentColor || 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 14);
    ctx.stroke();
  }

  ctx.shadowColor = timer.style === 'neon' ? (urgentColor || '#22d3ee') : 'transparent';
  ctx.shadowBlur = timer.style === 'neon' ? 14 : 0;
  ctx.fillStyle = timer.style === 'bold' ? 'white' : urgentColor || (timer.style === 'neon' ? '#22d3ee' : 'white');
  ctx.font = timeFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + width / 2, y + paddingY + (timer.style === 'bold' ? 30 : 27));

  if (isFinished) {
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = timer.style === 'bold' ? 'rgba(255, 255, 255, 0.82)' : urgentColor || 'rgba(255, 255, 255, 0.68)';
    ctx.font = '800 16px Inter, Arial, sans-serif';
    ctx.fillText('TIME', x + width / 2, y + height - 18);
  }

  ctx.restore();
}

function drawLowerThird(
  ctx: CanvasRenderingContext2D,
  lowerThird: LowerThirdData,
  brandColor: string,
  options: { hasBanner: boolean; hasTicker: boolean }
) {
  const paddingX = 34;
  const nameHeight = lowerThird.style === 'minimal' ? 58 : 64;
  const titleHeight = lowerThird.title ? 42 : 0;
  const height = nameHeight + titleHeight;
  const bottom = options.hasBanner ? 208 : options.hasTicker ? 104 : 74;
  const x = 80;
  const y = 1080 - bottom - height;
  const maxWidth = 720;
  const minWidth = 360;
  const normalizedAccentColor = normalizeLowerThirdAccentColor(lowerThird.accentColor);
  const accentColor = normalizedAccentColor || brandColor;

  ctx.save();
  ctx.font = lowerThird.style === 'bold' ? '700 34px Inter, Arial, sans-serif' : '700 32px Inter, Arial, sans-serif';
  const nameWidth = ctx.measureText(lowerThird.name).width;
  ctx.font = '500 24px Inter, Arial, sans-serif';
  const titleWidth = lowerThird.title ? ctx.measureText(lowerThird.title).width : 0;
  const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(Math.max(nameWidth, titleWidth) + paddingX * 2)));

  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;

  if (lowerThird.style === 'gradient') {
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, accentColor);
    gradient.addColorStop(1, '#ec4899');
    ctx.fillStyle = gradient;
    drawRoundedRect(ctx, x, y, width, height, 18);
  } else if (lowerThird.style === 'glass') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    drawRoundedRect(ctx, x, y, width, height, 18);
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = normalizedAccentColor || 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 18);
    ctx.stroke();
  } else if (lowerThird.style === 'bold') {
    ctx.fillStyle = accentColor;
    drawRoundedRect(ctx, x, y, width, nameHeight, 14);
    if (titleHeight > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
      drawRoundedRect(ctx, x, y + nameHeight - 4, width, titleHeight + 4, 12);
    }
  } else {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    drawRoundedRect(ctx, x, y, width, height, 14);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = accentColor;
    ctx.fillRect(x, y, 8, height);
  }

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'white';
  ctx.font = lowerThird.style === 'bold' ? '700 34px Inter, Arial, sans-serif' : '700 32px Inter, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncateCanvasText(ctx, lowerThird.name, width - paddingX * 2), x + paddingX, y + nameHeight / 2);

  if (lowerThird.title) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.84)';
    ctx.font = '500 24px Inter, Arial, sans-serif';
    ctx.fillText(
      truncateCanvasText(ctx, lowerThird.title, width - paddingX * 2),
      x + paddingX,
      y + nameHeight + titleHeight / 2 - 2
    );
  }
  ctx.restore();
}

function drawLiveCaption(
  ctx: CanvasRenderingContext2D,
  caption: LiveCaptionSegment,
  brandColor: string,
  options: { hasBanner: boolean; hasTicker: boolean; hasLowerThird: boolean; hasCenterOverlay: boolean }
) {
  const text = caption.text.trim();
  if (!text) return;

  const maxWidth = 1260;
  const minWidth = 560;
  const paddingX = 34;
  const paddingY = 24;
  const speakerHeight = caption.speakerName ? 28 : 0;
  const lineHeight = 42;
  const lineGap = 4;
  const reservedBottom = Math.max(
    52,
    options.hasTicker ? 112 : 0,
    options.hasLowerThird ? 164 : 0,
    options.hasBanner ? 224 : 0,
    options.hasCenterOverlay ? 188 : 0
  );

  ctx.save();
  ctx.font = '700 34px Inter, Arial, sans-serif';
  const lines = wrapCanvasText(ctx, text, maxWidth - paddingX * 2, 2);
  if (lines.length === 0) {
    ctx.restore();
    return;
  }
  const widestLine = lines.reduce((width, line) => Math.max(width, ctx.measureText(line).width), 0);
  ctx.font = '800 22px Inter, Arial, sans-serif';
  const speakerWidth = caption.speakerName ? ctx.measureText(caption.speakerName).width + 88 : 0;
  const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(Math.max(widestLine, speakerWidth) + paddingX * 2)));
  const height = paddingY * 2 + speakerHeight + lines.length * lineHeight + Math.max(0, lines.length - 1) * lineGap;
  const x = (1920 - width) / 2;
  const y = 1080 - reservedBottom - height;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
  drawRoundedRect(ctx, x, y, width, height, 18);

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = brandColor;
  ctx.fillRect(x, y, width, 6);

  let cursorY = y + paddingY;
  if (caption.speakerName) {
    ctx.fillStyle = brandColor;
    drawRoundedRect(ctx, x + paddingX, cursorY - 2, 54, 26, 6);
    ctx.fillStyle = 'white';
    ctx.font = '900 20px Inter, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('CC', x + paddingX + 14, cursorY + 11);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = '800 22px Inter, Arial, sans-serif';
    ctx.fillText(truncateCanvasText(ctx, caption.speakerName, width - paddingX * 2 - 72), x + paddingX + 72, cursorY + 11);
    cursorY += speakerHeight;
  }

  ctx.fillStyle = caption.interim ? 'rgba(255, 255, 255, 0.82)' : 'white';
  ctx.font = '700 34px Inter, Arial, sans-serif';
  ctx.textBaseline = 'top';
  lines.forEach((line, index) => {
    ctx.fillText(line, x + paddingX, cursorY + index * (lineHeight + lineGap));
  });

  ctx.restore();
}

function drawBroadcastComment(ctx: CanvasRenderingContext2D, comment: HighlightedComment, bottom: number) {
  const isFlash = comment.displayMode === 'flash';
  const width = 760;
  const padding = 26;
  const avatarSize = 56;
  const x = (1920 - width) / 2;
  const textX = x + padding + avatarSize + 20;
  const maxTextWidth = width - padding * 2 - avatarSize - 20;
  const label = isFlash ? 'AUDIENCE FLASH' : 'FEATURED COMMENT';

  ctx.save();
  ctx.font = '500 28px Inter, Arial, sans-serif';
  const contentLines = wrapCanvasText(ctx, comment.content, maxTextWidth, 2);
  const height = Math.max(126, padding * 2 + 42 + contentLines.length * 34);
  const y = 1080 - bottom - height;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = isFlash ? 'rgba(31, 23, 25, 0.86)' : 'rgba(15, 15, 20, 0.82)';
  drawRoundedRect(ctx, x, y, width, height, 22);
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = isFlash ? 'rgba(251, 191, 36, 0.28)' : 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 22);
  ctx.stroke();

  const accent = ctx.createLinearGradient(x, y, x + width, y);
  if (isFlash) {
    accent.addColorStop(0, '#facc15');
    accent.addColorStop(0.52, '#fb7185');
    accent.addColorStop(1, '#a78bfa');
  } else {
    accent.addColorStop(0, '#22d3ee');
    accent.addColorStop(0.48, '#a78bfa');
    accent.addColorStop(1, '#f472b6');
  }
  ctx.fillStyle = accent;
  drawRoundedRect(ctx, x, y, width, 8, 4);

  ctx.fillStyle = isFlash ? '#fef3c7' : '#cffafe';
  ctx.font = '800 18px Inter, Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, x + padding, y + padding - 4);

  ctx.fillStyle = comment.avatarColor || getAvatarColor(comment.senderName);
  ctx.beginPath();
  ctx.arc(x + padding + avatarSize / 2, y + padding + 26 + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'white';
  ctx.font = '800 24px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(comment.senderName.charAt(0).toUpperCase(), x + padding + avatarSize / 2, y + padding + 26 + avatarSize / 2 + 1);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.font = '800 25px Inter, Arial, sans-serif';
  ctx.fillText(truncateCanvasText(ctx, comment.senderName, maxTextWidth), textX, y + padding + 50);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.font = '500 28px Inter, Arial, sans-serif';
  contentLines.forEach((line, index) => {
    ctx.fillText(line, textX, y + padding + 90 + index * 34);
  });
  ctx.restore();
}

function drawBroadcastQA(
  ctx: CanvasRenderingContext2D,
  question: QAQuestion,
  brandColor: string,
  bottom: number
): number {
  const width = 720;
  const padding = 28;
  const x = 56;
  const maxTextWidth = width - padding * 2 - 42;

  ctx.save();
  ctx.font = '600 29px Inter, Arial, sans-serif';
  const questionLines = wrapCanvasText(ctx, question.content, maxTextWidth, 3);
  const answerLines = question.status === 'answered' && question.answer
    ? wrapCanvasText(ctx, question.answer, maxTextWidth, 2)
    : [];
  const height = padding * 2 + questionLines.length * 36 + 30 + (answerLines.length > 0 ? 24 + answerLines.length * 34 : 0);
  const y = 1080 - bottom - height;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  drawRoundedRect(ctx, x, y, width, height, 18);
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 18);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = brandColor;
  ctx.font = '900 28px Inter, Arial, sans-serif';
  ctx.fillText('Q:', x + padding, y + padding + 28);

  ctx.fillStyle = 'white';
  ctx.font = '600 29px Inter, Arial, sans-serif';
  questionLines.forEach((line, index) => {
    ctx.fillText(line, x + padding + 42, y + padding + 28 + index * 36);
  });

  const authorY = y + padding + questionLines.length * 36 + 22;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
  ctx.font = 'italic 22px Inter, Arial, sans-serif';
  ctx.fillText(`- ${truncateCanvasText(ctx, question.authorName, width - padding * 2)}`, x + padding + 42, authorY);

  if (answerLines.length > 0) {
    const answerTop = authorY + 30;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(x + padding, answerTop - 12);
    ctx.lineTo(x + width - padding, answerTop - 12);
    ctx.stroke();

    ctx.fillStyle = '#22c55e';
    ctx.font = '900 28px Inter, Arial, sans-serif';
    ctx.fillText('A:', x + padding, answerTop + 22);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = '500 27px Inter, Arial, sans-serif';
    answerLines.forEach((line, index) => {
      ctx.fillText(line, x + padding + 42, answerTop + 22 + index * 34);
    });
  }

  ctx.restore();
  return height;
}

function drawBroadcastPoll(
  ctx: CanvasRenderingContext2D,
  poll: LivePoll,
  brandColor: string,
  bottom: number
): number {
  const width = 680;
  const padding = 26;
  const x = 56;
  const maxTextWidth = width - padding * 2;

  ctx.save();
  ctx.font = '800 30px Inter, Arial, sans-serif';
  const questionLines = wrapCanvasText(ctx, poll.question, maxTextWidth, 2);
  const visibleOptions = poll.options.slice(0, 6);
  const optionHeight = 44;
  const height = padding * 2 + 24 + 18 + questionLines.length * 36 + 16 + visibleOptions.length * optionHeight + Math.max(0, visibleOptions.length - 1) * 10;
  const y = 1080 - bottom - height;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  drawRoundedRect(ctx, x, y, width, height, 18);
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 18);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#67e8f9';
  ctx.font = '900 20px Inter, Arial, sans-serif';
  ctx.fillText(poll.status === 'open' ? 'LIVE POLL' : 'POLL RESULTS', x + padding, y + padding + 20);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.68)';
  ctx.font = '800 20px Inter, Arial, sans-serif';
  const votesLabel = `${poll.totalVotes} vote${poll.totalVotes === 1 ? '' : 's'}`;
  ctx.fillText(votesLabel, x + width - padding - ctx.measureText(votesLabel).width, y + padding + 20);

  ctx.fillStyle = 'white';
  ctx.font = '800 30px Inter, Arial, sans-serif';
  questionLines.forEach((line, index) => {
    ctx.fillText(line, x + padding, y + padding + 64 + index * 36);
  });

  let optionY = y + padding + 64 + questionLines.length * 36 + 14;
  for (const option of visibleOptions) {
    const percent = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    drawRoundedRect(ctx, x + padding, optionY, maxTextWidth, optionHeight, 10);
    ctx.fillStyle = 'rgba(103, 232, 249, 0.25)';
    drawRoundedRect(ctx, x + padding, optionY, Math.max(6, (maxTextWidth * percent) / 100), optionHeight, 10);

    ctx.fillStyle = 'white';
    ctx.font = '800 23px Inter, Arial, sans-serif';
    const percentText = `${percent}%`;
    const percentWidth = ctx.measureText(percentText).width;
    ctx.fillText(
      truncateCanvasText(ctx, option.text, maxTextWidth - percentWidth - 34),
      x + padding + 16,
      optionY + 29
    );

    ctx.fillStyle = '#cffafe';
    ctx.font = '900 22px Inter, Arial, sans-serif';
    ctx.fillText(percentText, x + padding + maxTextWidth - percentWidth - 16, optionY + 29);
    optionY += optionHeight + 10;
  }

  ctx.restore();
  return height;
}

function drawBroadcastReactions(
  ctx: CanvasRenderingContext2D,
  reactions: FloatingReaction[],
  now: number
) {
  if (reactions.length === 0) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const item of reactions) {
    const elapsed = now - item.createdAt - item.delayMs;
    if (elapsed < 0 || elapsed > REACTION_OVERLAY_DURATION_MS) continue;

    const progress = elapsed / REACTION_OVERLAY_DURATION_MS;
    const eased = 1 - Math.pow(1 - progress, 3);
    const x = (item.lane / 100) * 1920 + Math.sin(progress * Math.PI * 2) * 28;
    const y = 1000 - eased * 420;
    const opacity = progress < 0.14
      ? progress / 0.14
      : Math.max(0, 1 - Math.max(0, progress - 0.72) / 0.28);
    const scale = 0.78 + Math.sin(Math.min(progress, 1) * Math.PI) * 0.28;
    const emoji = CHAT_REACTION_EMOJIS[item.reaction];

    ctx.globalAlpha = Math.min(1, opacity);
    ctx.font = `${Math.round(item.size * 2.1 * scale)}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 10;
    ctx.fillText(emoji, x, y);
  }
  ctx.restore();
}

function getStreamScreenCountdownLabel(screen: ActiveStreamScreen, now: number): string {
  if (screen.kind !== 'starting' || screen.countdownSeconds === undefined) {
    return screen.kind === 'starting' ? 'Starting Soon' : 'Stream Ending';
  }
  const elapsedSeconds = Math.floor((now - screen.activatedAtMs) / 1000);
  const remaining = Math.max(0, screen.countdownSeconds - elapsedSeconds);
  if (remaining <= 0) return 'Starting Soon';
  return `Starting in ${formatTimerTime(remaining)}`;
}

function drawStreamScreen(
  ctx: CanvasRenderingContext2D,
  screen: ActiveStreamScreen,
  logoImage: HTMLImageElement | null,
  now: number
) {
  const width = 1920;
  const height = 1080;
  const brandColor = screen.brandColor || '#a78bfa';

  ctx.save();

  const vignette = ctx.createRadialGradient(960, 460, 220, 960, 540, 980);
  vignette.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
  vignette.addColorStop(0.58, 'rgba(2, 6, 23, 0.14)');
  vignette.addColorStop(1, 'rgba(2, 6, 23, 0.58)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(2, 6, 23, 0.24)';
  ctx.fillRect(0, 0, width, height);

  const contentWidth = 1320;
  const centerX = width / 2;
  let cursorY = 256;

  if (screen.logoUrl && logoImage?.complete && logoImage.naturalWidth > 0) {
    const maxLogoWidth = 340;
    const maxLogoHeight = 116;
    const logoScale = Math.min(1, maxLogoWidth / logoImage.naturalWidth, maxLogoHeight / logoImage.naturalHeight);
    const logoWidth = logoImage.naturalWidth * logoScale;
    const logoHeight = logoImage.naturalHeight * logoScale;
    ctx.globalAlpha = 0.96;
    ctx.drawImage(logoImage, centerX - logoWidth / 2, cursorY - logoHeight / 2, logoWidth, logoHeight);
    ctx.globalAlpha = 1;
    cursorY += logoHeight / 2 + 82;
  }

  const label = getStreamScreenCountdownLabel(screen, now).toUpperCase();
  ctx.font = '900 27px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelWidth = Math.min(520, Math.max(250, Math.ceil(ctx.measureText(label).width + 64)));
  const labelHeight = 56;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
  drawRoundedRect(ctx, centerX - labelWidth / 2, cursorY - labelHeight / 2, labelWidth, labelHeight, 18);
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = `${brandColor}bb`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(centerX - labelWidth / 2, cursorY - labelHeight / 2, labelWidth, labelHeight, 18);
  ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(label, centerX, cursorY + 1);

  cursorY += 132;
  ctx.font = '900 88px Inter, Arial, sans-serif';
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 14;
  const headlineLines = wrapCanvasText(ctx, screen.headline, contentWidth, 2);
  headlineLines.forEach((line, index) => {
    ctx.fillText(line, centerX, cursorY + index * 100);
  });

  cursorY += Math.max(1, headlineLines.length) * 100 + 30;
  ctx.shadowColor = 'transparent';
  ctx.font = '600 38px Inter, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  const messageLines = wrapCanvasText(ctx, screen.message, 980, 2);
  messageLines.forEach((line, index) => {
    ctx.fillText(line, centerX, cursorY + index * 52);
  });

  const accentWidth = 420;
  const accentY = 884;
  const accent = ctx.createLinearGradient(centerX - accentWidth / 2, accentY, centerX + accentWidth / 2, accentY);
  accent.addColorStop(0, 'rgba(255, 255, 255, 0)');
  accent.addColorStop(0.5, brandColor);
  accent.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = accent;
  drawRoundedRect(ctx, centerX - accentWidth / 2, accentY, accentWidth, 8, 4);

  ctx.restore();
}

export function useCompositor({
  containerRef,
  isLive,
  banners,
  lowerThirds,
  timers,
  tickers,
  activeMedia,
  highlightedComment,
  highlightedQA,
  highlightedPoll,
  floatingReactions = [],
  caption,
  stageBackground,
  brandColor = '#3b82f6',
  logoUrl,
  logoPlacement = 'top-right',
  logoSize = 'medium',
  logoOpacity = DEFAULT_LOGO_OPACITY,
  streamScreen,
}: CompositorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeStreamRef = useRef<MediaStream | null>(null);
  const rAF = useRef<number>(0);
  const logoImageRef = useRef<HTMLImageElement | null>(null);
  const backgroundImageRef = useRef<HTMLImageElement | null>(null);
  const activeMediaImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    logoImageRef.current = null;
    if (!logoUrl) return;

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = logoUrl;
    img.onload = () => {
      if (!cancelled) logoImageRef.current = img;
    };
    img.onerror = () => {
      if (!cancelled) logoImageRef.current = null;
    };
    return () => {
      cancelled = true;
    };
  }, [logoUrl]);

  useEffect(() => {
    backgroundImageRef.current = null;
    if (stageBackground?.type !== 'image' || !stageBackground.value) return;

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = stageBackground.value;
    img.onload = () => {
      if (!cancelled) backgroundImageRef.current = img;
    };
    img.onerror = () => {
      if (!cancelled) backgroundImageRef.current = null;
    };
    return () => {
      cancelled = true;
    };
  }, [stageBackground]);

  useEffect(() => {
    activeMediaImageRef.current = null;
    if (activeMedia?.type !== 'image' || !activeMedia.url) return;

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = activeMedia.url;
    img.onload = () => {
      if (!cancelled) activeMediaImageRef.current = img;
    };
    img.onerror = () => {
      if (!cancelled) activeMediaImageRef.current = null;
    };
    return () => {
      cancelled = true;
    };
  }, [activeMedia?.type, activeMedia?.url]);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    canvasRef.current = canvas;
    
    // Capture the canvas video stream at 30 fps
    try {
      compositeStreamRef.current = canvas.captureStream(30);
    } catch (err) {
      console.warn('captureStream not supported in this environment');
    }

    return () => {
      cancelAnimationFrame(rAF.current);
    };
  }, []);

  const drawLoop = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // 1. Clear & stage background
    if (streamScreen) {
      drawStageBackground(ctx, streamScreen.background, backgroundImageRef.current);
      drawStreamScreen(ctx, streamScreen, logoImageRef.current, Date.now());
      rAF.current = requestAnimationFrame(drawLoop);
      return;
    }

    drawStageBackground(ctx, stageBackground, backgroundImageRef.current);

    const containerBounds = containerRef.current.getBoundingClientRect();
    if (containerBounds.width === 0 || containerBounds.height === 0) {
      rAF.current = requestAnimationFrame(drawLoop);
      return;
    }
    
    const scaleX = 1920 / containerBounds.width;
    const scaleY = 1080 / containerBounds.height;

    // 2. Draw Videos mapped precisely from DOM coordinates
    const videos = containerRef.current.querySelectorAll('video');
    videos.forEach((video) => {
      if (video.closest('.studio-active-media')) return;

      const rect = video.getBoundingClientRect();
      const x = (rect.left - containerBounds.left) * scaleX;
      const y = (rect.top - containerBounds.top) * scaleY;
      const w = rect.width * scaleX;
      const h = rect.height * scaleY;

      if (video.readyState >= 2) {
        // Draw the local/remote video frame
        ctx.drawImage(video, x, y, w, h);
      }
      
      // Attempt to draw name tags for each participant tile
      const tileNode = video.closest('.participant-tile');
      if (tileNode) {
        const nameTag = tileNode.querySelector('.name-tag') as HTMLElement;
        if (nameTag) {
          const tagRect = nameTag.getBoundingClientRect();
          const tx = (tagRect.left - containerBounds.left) * scaleX;
          const ty = (tagRect.top - containerBounds.top) * scaleY;
          const tw = tagRect.width * scaleX;
          const th = tagRect.height * scaleY;
          
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.beginPath();
          ctx.roundRect(tx, ty, tw, th, 6 * scaleX);
          ctx.fill();
          
          ctx.fillStyle = 'white';
          ctx.font = '24px Inter, sans-serif';
          ctx.fillText(nameTag.innerText, tx + 10 * scaleX, ty + 24 * scaleY);
        }
      }
    });

    if (activeMedia) {
      drawActiveMediaOverlay(
        ctx,
        activeMedia,
        containerRef.current.querySelector('.studio-active-media'),
        containerBounds,
        scaleX,
        scaleY,
        activeMediaImageRef.current,
        brandColor
      );
    }

    // 3. Draw logo watermark with the same placement and max-size rules as the stage.
    const logoImage = logoImageRef.current;
    if (logoImage?.complete && logoImage.naturalWidth > 0) {
      const rect = getLogoCanvasRect(logoImage, logoPlacement, logoSize, scaleX, scaleY);
      if (rect) {
        ctx.save();
        ctx.globalAlpha = normalizeLogoOpacity(logoOpacity);
        ctx.drawImage(logoImage, rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      }
    }

    const activeBanners = banners.filter(b => b.visible);
    const activeTickers = tickers.filter(t => t.visible);
    const activeLowerThird = lowerThirds.find(lt => lt.visible);
    if (activeLowerThird) {
      drawLowerThird(ctx, activeLowerThird, brandColor, {
        hasBanner: activeBanners.length > 0,
        hasTicker: activeTickers.length > 0,
      });
    }

    // 4. Draw Active Banners
    if (activeBanners.length > 0) {
      const banner = activeBanners[0]; // Streaming engines typically composite one primary banner
      const bh = 100;
      const by = 1080 - bh - 80; // 80px margin from bottom
      const bw = 1760;
      const bx = 80;
      
      ctx.fillStyle = banner.style === 'custom' ? (banner.customColor || brandColor) : banner.style === 'breaking' ? '#dc2626' : banner.style === 'alert' ? '#d97706' : banner.style === 'info' ? '#2563eb' : brandColor;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 12);
      ctx.fill();
      
      ctx.fillStyle = 'white';
      ctx.font = 'bold 38px Inter, sans-serif';
      ctx.fillText(banner.text, bx + 40, by + 62);
    }
    
    // 5. Draw Active Tickers
    if (activeTickers.length > 0) {
      const ticker = activeTickers[0];
      const th = 60;
      const ty = 1080 - th;
      
      ctx.fillStyle = brandColor;
      ctx.fillRect(0, ty, 1920, th);
      
      ctx.fillStyle = 'white';
      ctx.font = '28px Inter, sans-serif';
      // Simple static text since marquee animation speed is hard to sync efficiently in raw canvas without an offset counter
      ctx.fillText(ticker.text, 40, ty + 40);
    }

    timers.filter((timer) => timer.visible).forEach((timer) => {
      drawBroadcastTimer(ctx, timer, brandColor, {
        hasBanner: activeBanners.length > 0,
        hasTicker: activeTickers.length > 0,
        hasLowerThird: Boolean(activeLowerThird),
      });
    });

    if (caption) {
      drawLiveCaption(ctx, caption, brandColor, {
        hasBanner: activeBanners.length > 0,
        hasTicker: activeTickers.length > 0,
        hasLowerThird: Boolean(activeLowerThird),
        hasCenterOverlay: Boolean(highlightedComment),
      });
    }

    const reservedBottom = activeBanners.length > 0 ? 204 : activeTickers.length > 0 ? 84 : 48;
    let leftOverlayBottom = reservedBottom;
    if (highlightedPoll) {
      leftOverlayBottom += drawBroadcastPoll(ctx, highlightedPoll, brandColor, leftOverlayBottom) + 24;
    }
    if (highlightedQA) {
      drawBroadcastQA(ctx, highlightedQA, brandColor, leftOverlayBottom);
    }
    if (highlightedComment) {
      drawBroadcastComment(ctx, highlightedComment, Math.max(reservedBottom, 96));
    }
    drawBroadcastReactions(ctx, floatingReactions, Date.now());

    // Loop
    rAF.current = requestAnimationFrame(drawLoop);
  }, [containerRef, banners, lowerThirds, timers, tickers, activeMedia, highlightedComment, highlightedQA, highlightedPoll, floatingReactions, caption, stageBackground, brandColor, logoPlacement, logoSize, logoOpacity, streamScreen]);

  useEffect(() => {
    if (isLive) {
      console.log('Compositor Engine Started: Drawing 1080p canvas at 30FPS');
      cancelAnimationFrame(rAF.current); // Guard against multi-ticks
      rAF.current = requestAnimationFrame(drawLoop);
    } else {
      cancelAnimationFrame(rAF.current);
    }
    
    // Cleanup to prevent memory leaks when drawLoop dependencies change
    return () => {
      cancelAnimationFrame(rAF.current);
    };
  }, [isLive, drawLoop]);

  return { compositeStreamRef, compositeCanvasRef: canvasRef };
}
