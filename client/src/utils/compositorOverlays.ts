import type { BannerData } from '../components/BannerOverlay.tsx';
import type { LowerThirdData } from '../components/LowerThird.tsx';
import type { TickerData } from '../components/TickerOverlay.tsx';
import { cubicBezier, EASE_IN, EASE_OUT, transitionProgress, type OverlayPhase } from './canvasMotion.ts';
import {
  LOWER_THIRD_ANIMATION_EXIT_MS,
  normalizeLowerThirdAnimation,
  normalizeLowerThirdAnimationDirection,
  type LowerThirdAnimationDirection,
} from './lowerThirds.ts';
import type { SceneTransitionPresetId } from './sceneTransitions.ts';

/**
 * Banners, tickers, lower-third motion and scene transitions drawn into the
 * program canvas the way the stage preview shows them. Sizes are the
 * preview's CSS pixels scaled by the stage-to-output factor, so what the
 * host lays out is what viewers get.
 */

export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;
const OVERLAY_FONT_FAMILY = 'Inter, Arial, sans-serif';

/** CSS px to output px. */
export interface OverlayScale {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Tickers (TickerOverlayDisplay)
// ---------------------------------------------------------------------------

/** Seconds for the ticker track to scroll one block of text (shared with the preview). */
export const TICKER_SPEED_DURATION_SECONDS: Record<TickerData['speed'], number> = {
  slow: 30,
  normal: 20,
  fast: 12,
};
/** The preview repeats the segment this many times per scrolling block. */
export const TICKER_SEGMENT_REPEAT = 8;
export const TICKER_BAR_HEIGHT_CSS = 36;
const TICKER_EDGE_FADE_CSS = 48;

export function getTickerSegment(ticker: Pick<TickerData, 'text' | 'separator'>): string {
  return `${ticker.text} ${ticker.separator} `;
}

/**
 * How far the ticker has scrolled, in output px: the preview moves one block
 * (eight segments) every SPEED_DURATION seconds, linearly, looping.
 */
export function getTickerScrollOffset(elapsedMs: number, speed: TickerData['speed'], segmentWidth: number): number {
  const durationMs = (TICKER_SPEED_DURATION_SECONDS[speed] ?? TICKER_SPEED_DURATION_SECONDS.normal) * 1000;
  const blockWidth = segmentWidth * TICKER_SEGMENT_REPEAT;
  if (blockWidth <= 0 || durationMs <= 0) return 0;
  const phase = (((elapsedMs % durationMs) + durationMs) % durationMs) / durationMs;
  return phase * blockWidth;
}

function setLetterSpacing(ctx: CanvasRenderingContext2D, value: string) {
  const target = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in target) target.letterSpacing = value;
}

export function drawTickerOverlay(
  ctx: CanvasRenderingContext2D,
  ticker: TickerData,
  elapsedMs: number,
  scale: OverlayScale
) {
  const height = TICKER_BAR_HEIGHT_CSS * scale.y;
  const y = OUTPUT_HEIGHT - height;
  ctx.save();
  ctx.fillStyle = ticker.backgroundColor;
  ctx.fillRect(0, y, OUTPUT_WIDTH, height);

  ctx.beginPath();
  ctx.rect(0, y, OUTPUT_WIDTH, height);
  ctx.clip();
  ctx.font = `600 ${14 * scale.y}px ${OVERLAY_FONT_FAMILY}`;
  setLetterSpacing(ctx, `${0.02 * 14 * scale.x}px`);
  ctx.fillStyle = ticker.textColor;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const segment = getTickerSegment(ticker);
  const segmentWidth = ctx.measureText(segment).width;
  if (segmentWidth > 0) {
    let x = -getTickerScrollOffset(elapsedMs, ticker.speed, segmentWidth);
    // Seamless: the segment repeats across the whole bar.
    while (x < OUTPUT_WIDTH) {
      if (x + segmentWidth > 0) ctx.fillText(segment, x, y + height / 2);
      x += segmentWidth;
    }
  }
  setLetterSpacing(ctx, '0px');

  const fade = TICKER_EDGE_FADE_CSS * scale.x;
  const left = ctx.createLinearGradient(0, 0, fade, 0);
  left.addColorStop(0, ticker.backgroundColor);
  left.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, y, fade, height);
  const right = ctx.createLinearGradient(OUTPUT_WIDTH - fade, 0, OUTPUT_WIDTH, 0);
  right.addColorStop(0, 'rgba(0, 0, 0, 0)');
  right.addColorStop(1, ticker.backgroundColor);
  ctx.fillStyle = right;
  ctx.fillRect(OUTPUT_WIDTH - fade, y, fade, height);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Banners (BannerOverlayDisplay)
// ---------------------------------------------------------------------------

export const BANNER_BAR_HEIGHT_CSS = 36;
/** A bottom banner sits above the ticker strip. */
export const BANNER_BOTTOM_OFFSET_CSS = 36;
/** Preview marquee speed for scrolling banners, CSS px per second (minimum 8 s per pass). */
export const BANNER_TICKER_PX_PER_SECOND = 80;
const BANNER_TICKER_MIN_SECONDS = 8;

const BANNER_COLORS: Record<Exclude<BannerData['style'], 'custom'>, string> = {
  breaking: '#dc2626',
  info: '#2563eb',
  alert: '#d97706',
};

export function getBannerColor(banner: Pick<BannerData, 'style' | 'customColor'>): string {
  if (banner.style === 'custom') return banner.customColor || '#7c3aed';
  return BANNER_COLORS[banner.style] ?? BANNER_COLORS.info;
}

export function getBannerLabel(banner: Pick<BannerData, 'style'>): string | null {
  if (banner.style === 'breaking') return 'BREAKING';
  if (banner.style === 'alert') return 'ALERT';
  return null;
}

/** Top edge of the banner bar, in output px. */
export function getBannerTop(position: BannerData['position'], scale: OverlayScale): number {
  if (position === 'top') return 0;
  return OUTPUT_HEIGHT - (BANNER_BOTTOM_OFFSET_CSS + BANNER_BAR_HEIGHT_CSS) * scale.y;
}

/**
 * Scrolling banner text position: from the right edge of the banner to fully
 * off its left side, like the preview's keyframes. `trackWidth` and
 * `textWidth` in output px.
 */
export function getBannerTickerX(elapsedMs: number, trackWidth: number, textWidth: number, scale: OverlayScale): number {
  const distance = trackWidth + textWidth;
  if (distance <= 0) return 0;
  const durationMs = Math.max(BANNER_TICKER_MIN_SECONDS, distance / scale.x / BANNER_TICKER_PX_PER_SECOND) * 1000;
  const phase = (((elapsedMs % durationMs) + durationMs) % durationMs) / durationMs;
  return trackWidth - phase * distance;
}

export function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '...';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}${ellipsis}`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}${ellipsis}`;
}

export function drawBannerOverlay(
  ctx: CanvasRenderingContext2D,
  banner: BannerData,
  elapsedMs: number,
  scale: OverlayScale
) {
  const height = BANNER_BAR_HEIGHT_CSS * scale.y;
  const y = getBannerTop(banner.position, scale);
  const label = getBannerLabel(banner);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 24 * scale.y;
  ctx.shadowOffsetY = 4 * scale.y;
  ctx.fillStyle = getBannerColor(banner);
  ctx.fillRect(0, y, OUTPUT_WIDTH, height);
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.rect(0, y, OUTPUT_WIDTH, height);
  ctx.clip();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const centerY = y + height / 2;

  if (banner.isTicker) {
    let trackStart = 0;
    if (label) {
      ctx.font = `800 ${12 * scale.y}px ${OVERLAY_FONT_FAMILY}`;
      setLetterSpacing(ctx, `${0.08 * 12 * scale.x}px`);
      const labelWidth = ctx.measureText(label).width + 28 * scale.x;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(0, y, labelWidth, height);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, 14 * scale.x, centerY);
      setLetterSpacing(ctx, '0px');
      trackStart = labelWidth;
    }
    ctx.beginPath();
    ctx.rect(trackStart, y, OUTPUT_WIDTH - trackStart, height);
    ctx.clip();
    ctx.font = `600 ${14 * scale.y}px ${OVERLAY_FONT_FAMILY}`;
    const padding = 12 * scale.x;
    const textWidth = ctx.measureText(banner.text).width + padding * 2;
    const x = trackStart + getBannerTickerX(elapsedMs, OUTPUT_WIDTH, textWidth, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(banner.text, x + padding, centerY);
    ctx.restore();
    return;
  }

  let x = 16 * scale.x;
  if (label) {
    ctx.font = `800 ${11 * scale.y}px ${OVERLAY_FONT_FAMILY}`;
    setLetterSpacing(ctx, `${0.08 * 11 * scale.x}px`);
    const pillWidth = ctx.measureText(label).width + 20 * scale.x;
    const pillHeight = (11 * 1.25 + 6) * scale.y;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.roundRect(x, centerY - pillHeight / 2, pillWidth, pillHeight, 4 * scale.y);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 10 * scale.x, centerY);
    setLetterSpacing(ctx, '0px');
    x += pillWidth + 10 * scale.x;
  }
  ctx.font = `600 ${14 * scale.y}px ${OVERLAY_FONT_FAMILY}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(truncateText(ctx, banner.text, OUTPUT_WIDTH - x - 16 * scale.x), x, centerY);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Lower thirds (LowerThirdOverlay + getLowerThirdAnimationStyle)
// ---------------------------------------------------------------------------

export interface CanvasMotion {
  alpha: number;
  /** Output px. */
  offsetX: number;
  offsetY: number;
  scale: number;
}

export const STILL_MOTION: CanvasMotion = { alpha: 1, offsetX: 0, offsetY: 0, scale: 1 };
const LOWER_THIRD_EASE = cubicBezier(0.16, 1, 0.3, 1);
const LOWER_THIRD_BOUNCE_EASE = cubicBezier(0.34, 1.56, 0.64, 1);

/** The preview's hidden offset per direction, CSS px. */
export function getLowerThirdHiddenOffsetCss(direction: LowerThirdAnimationDirection): { x: number; y: number } {
  switch (direction) {
    case 'right':
      return { x: 24, y: 16 };
    case 'up':
      return { x: 0, y: 24 };
    case 'down':
      return { x: 0, y: -24 };
    case 'left':
    default:
      return { x: -24, y: 16 };
  }
}

/** How long a lower third keeps drawing after it is hidden. */
export const LOWER_THIRD_CANVAS_EXIT_MS = LOWER_THIRD_ANIMATION_EXIT_MS;

/**
 * The lower third's opacity and transform `elapsedMs` into its enter or exit
 * transition, matching the preview's CSS transitions.
 */
export function getLowerThirdCanvasMotion(
  lowerThird: Pick<LowerThirdData, 'animation' | 'animationDirection'>,
  phase: OverlayPhase,
  elapsedMs: number,
  scale: OverlayScale
): CanvasMotion {
  const animation = normalizeLowerThirdAnimation(lowerThird.animation);
  const offset = getLowerThirdHiddenOffsetCss(normalizeLowerThirdAnimationDirection(lowerThird.animationDirection));
  const entering = phase === 'entering';
  // Share of the way to "shown": 0 = hidden, 1 = shown.
  const shownShare = (durationMs: number, easing: (t: number) => number) => {
    const progress = transitionProgress(elapsedMs, durationMs, easing);
    return entering ? progress : 1 - progress;
  };

  if (animation === 'fade') {
    return { ...STILL_MOTION, alpha: shownShare(320, LOWER_THIRD_EASE) };
  }
  if (animation === 'bounce') {
    const alpha = entering ? shownShare(260, EASE_OUT) : shownShare(220, EASE_IN);
    const move = entering ? shownShare(420, LOWER_THIRD_BOUNCE_EASE) : shownShare(260, EASE_IN);
    return {
      alpha,
      offsetX: offset.x * (1 - move) * scale.x,
      offsetY: offset.y * (1 - move) * scale.y,
      scale: 0.94 + 0.06 * move,
    };
  }
  const move = shownShare(400, LOWER_THIRD_EASE);
  return {
    alpha: shownShare(360, LOWER_THIRD_EASE),
    offsetX: offset.x * (1 - move) * scale.x,
    offsetY: offset.y * (1 - move) * scale.y,
    scale: 1,
  };
}

/** Apply a motion around the box's centre; the caller wraps this in save/restore. */
export function applyCanvasMotion(
  ctx: CanvasRenderingContext2D,
  motion: CanvasMotion,
  box: { x: number; y: number; width: number; height: number }
) {
  ctx.globalAlpha *= Math.min(1, Math.max(0, motion.alpha));
  ctx.translate(motion.offsetX, motion.offsetY);
  if (motion.scale !== 1) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(motion.scale, motion.scale);
    ctx.translate(-cx, -cy);
  }
}

// ---------------------------------------------------------------------------
// Scene transitions (getSceneTransitionOverlayStyle)
// ---------------------------------------------------------------------------

export interface CompositorSceneTransition {
  presetId: SceneTransitionPresetId;
  sceneName: string;
  /** performance.now() when the overlay started revealing the new scene. */
  startedAt: number;
  durationMs: number;
}

export interface SceneTransitionCanvasState {
  alpha: number;
  /** Fraction of the width hidden from the left (wipe). */
  clipLeft: number;
  /** Fraction of the width the overlay has moved right (slide). */
  translateX: number;
  scale: number;
  done: boolean;
}

const SCENE_TRANSITION_EASE = cubicBezier(0.22, 1, 0.36, 1);

export function clampSceneTransitionDuration(durationMs: number): number {
  return Math.max(120, Math.min(1500, Math.round(durationMs)));
}

/**
 * The overlay covers the stage when the scene switches, then reveals the new
 * scene: it fades (crossfade), wipes off to the right, slides out, or fades
 * while zooming. A stinger stays up until its clip ends.
 */
export function getSceneTransitionCanvasState(
  presetId: SceneTransitionPresetId,
  elapsedMs: number,
  durationMs: number
): SceneTransitionCanvasState {
  const duration = clampSceneTransitionDuration(durationMs);
  const t = transitionProgress(elapsedMs, duration, SCENE_TRANSITION_EASE);
  const done = presetId !== 'stinger' && elapsedMs >= duration;
  switch (presetId) {
    case 'wipe':
      return { alpha: 1, clipLeft: t, translateX: 0, scale: 1, done };
    case 'slide':
      return { alpha: 1, clipLeft: 0, translateX: 1.05 * t, scale: 1, done };
    case 'zoom':
      return { alpha: 1 - t, clipLeft: 0, translateX: 0, scale: 1 + 0.08 * t, done };
    case 'stinger':
      return { alpha: 1, clipLeft: 0, translateX: 0, scale: 1, done: elapsedMs >= durationMs };
    case 'fade':
    default:
      return { alpha: 1 - t, clipLeft: 0, translateX: 0, scale: 1, done };
  }
}

function withAlpha(hex: string, alphaHex: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alphaHex}` : hex;
}

function fillSceneTransitionBackground(
  ctx: CanvasRenderingContext2D,
  presetId: SceneTransitionPresetId,
  brandColor: string
) {
  if (presetId === 'wipe' || presetId === 'slide') {
    const gradient = ctx.createLinearGradient(0, 0, OUTPUT_WIDTH, 0);
    gradient.addColorStop(0, presetId === 'wipe' ? 'rgba(2, 6, 23, 0.92)' : 'rgba(15, 23, 42, 0.94)');
    gradient.addColorStop(1, withAlpha(brandColor, presetId === 'wipe' ? '66' : '55'));
    ctx.fillStyle = gradient;
  } else if (presetId === 'stinger') {
    ctx.fillStyle = 'rgba(2, 6, 23, 0.72)';
  } else if (presetId === 'zoom') {
    ctx.fillStyle = 'rgba(2, 6, 23, 0.42)';
  } else {
    ctx.fillStyle = 'rgba(2, 6, 23, 0.38)';
  }
  ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
}

function drawSceneLabel(ctx: CanvasRenderingContext2D, sceneName: string, scale: OverlayScale) {
  ctx.font = `700 ${14 * scale.y}px ${OVERLAY_FONT_FAMILY}`;
  const paddingX = 16 * scale.x;
  const maxWidth = Math.min(OUTPUT_WIDTH * 0.7, 520 * scale.x);
  const text = truncateText(ctx, sceneName, maxWidth - paddingX * 2);
  const width = Math.min(maxWidth, ctx.measureText(text).width + paddingX * 2);
  const height = (14 * 1.2 + 20) * scale.y;
  const x = (OUTPUT_WIDTH - width) / 2;
  const y = (OUTPUT_HEIGHT - height) / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = 48 * scale.y;
  ctx.shadowOffsetY = 18 * scale.y;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = Math.max(1, scale.y);
  ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, OUTPUT_WIDTH / 2, y + height / 2);
  ctx.restore();
}

/**
 * Draw the transition overlay over the finished frame. `drawStinger` draws
 * the stinger clip when it is safe to draw (see canDrawMediaVideo) and
 * returns false otherwise, in which case the scene name is shown instead.
 */
export function drawSceneTransitionOverlay(
  ctx: CanvasRenderingContext2D,
  transition: CompositorSceneTransition,
  now: number,
  brandColor: string,
  scale: OverlayScale,
  drawStinger?: () => boolean
): boolean {
  const state = getSceneTransitionCanvasState(transition.presetId, now - transition.startedAt, transition.durationMs);
  if (state.done || state.alpha <= 0.001 || state.clipLeft >= 0.999 || state.translateX >= 1.05) return false;
  ctx.save();
  ctx.globalAlpha *= state.alpha;
  if (state.clipLeft > 0) {
    ctx.beginPath();
    ctx.rect(OUTPUT_WIDTH * state.clipLeft, 0, OUTPUT_WIDTH * (1 - state.clipLeft), OUTPUT_HEIGHT);
    ctx.clip();
  }
  if (state.translateX > 0) ctx.translate(OUTPUT_WIDTH * state.translateX, 0);
  if (state.scale !== 1) {
    ctx.translate(OUTPUT_WIDTH / 2, OUTPUT_HEIGHT / 2);
    ctx.scale(state.scale, state.scale);
    ctx.translate(-OUTPUT_WIDTH / 2, -OUTPUT_HEIGHT / 2);
  }
  fillSceneTransitionBackground(ctx, transition.presetId, brandColor);
  const stingerDrawn = transition.presetId === 'stinger' && drawStinger ? drawStinger() : false;
  if (!stingerDrawn) drawSceneLabel(ctx, transition.sceneName, scale);
  ctx.restore();
  return true;
}
