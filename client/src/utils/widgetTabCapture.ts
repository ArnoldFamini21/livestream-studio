/**
 * Web widgets are cross-origin iframes, which a canvas cannot read, so the
 * program draws a placeholder for them. In Chromium the host can opt in to
 * capturing this tab (getDisplayMedia with preferCurrentTab) and cropping the
 * capture to each widget's element (Region Capture: CropTarget.fromElement +
 * track.cropTo). Each widget gets its own cropped clone of the one capture,
 * played in a detached <video> the compositor draws into the widget's box.
 * Everything runs in the browser; nothing is uploaded.
 */

/** Captured widget frames by widget id, read by the compositor every frame. */
export type WidgetCaptureSources = Map<string, HTMLVideoElement>;

export const WIDGET_CAPTURE_ATTRIBUTE = 'data-widget-capture-id';
export const WIDGET_CAPTURE_FRAME_RATE = 15;
export const WIDGET_STUDIO_ONLY_LABEL = 'Studio only — viewers see a placeholder';

export interface WidgetCaptureSupport {
  supported: boolean;
  reason: string | null;
}

interface CaptureGlobals {
  navigator?: { mediaDevices?: { getDisplayMedia?: unknown } };
  CropTarget?: { fromElement?: unknown };
  BrowserCaptureMediaStreamTrack?: { prototype?: { cropTo?: unknown } };
  isSecureContext?: boolean;
}

/** Region Capture is Chromium-only (Chrome/Edge 104+ on desktop). */
export function getWidgetTabCaptureSupport(scope: CaptureGlobals = globalThis as unknown as CaptureGlobals): WidgetCaptureSupport {
  if (scope.isSecureContext === false) return { supported: false, reason: 'Tab capture needs a secure (https) page.' };
  if (typeof scope.navigator?.mediaDevices?.getDisplayMedia !== 'function') {
    return { supported: false, reason: 'This browser cannot capture a tab.' };
  }
  if (typeof scope.CropTarget?.fromElement !== 'function' || typeof scope.BrowserCaptureMediaStreamTrack?.prototype?.cropTo !== 'function') {
    return { supported: false, reason: 'Widget capture needs Chrome or Edge on a computer.' };
  }
  return { supported: true, reason: null };
}

/** getDisplayMedia options that offer this tab first and capture no audio. */
export function getWidgetTabCaptureOptions(): DisplayMediaStreamOptions & Record<string, unknown> {
  return {
    video: { frameRate: { ideal: WIDGET_CAPTURE_FRAME_RATE, max: 30 } },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'exclude',
  };
}

/** A capture is usable only when it is a browser tab (cropping fails for windows and screens). */
export function isTabCaptureTrack(track: Pick<MediaStreamTrack, 'getSettings'>): boolean {
  const settings = (typeof track.getSettings === 'function' ? track.getSettings() : {}) as MediaTrackSettings & { displaySurface?: string };
  return !settings.displaySurface || settings.displaySurface === 'browser';
}

export interface CropCapableTrack extends MediaStreamTrack {
  cropTo(target: unknown): Promise<void>;
}

interface CropTargetFactory {
  fromElement(element: Element): Promise<unknown>;
}

/** Crops a capture clone to an element of the captured tab. */
export async function cropTrackToElement(
  track: MediaStreamTrack,
  element: Element,
  cropTarget: CropTargetFactory = (globalThis as unknown as { CropTarget: CropTargetFactory }).CropTarget
): Promise<void> {
  const target = await cropTarget.fromElement(element);
  await (track as CropCapableTrack).cropTo(target);
}

export interface WidgetCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Draws a widget's latest captured frame into its box (cover fit, rounded).
 * Returns false when there is no frame yet, so the caller draws the placeholder.
 */
export function drawWidgetCaptureFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  rect: WidgetCaptureRect,
  radius = 0
): boolean {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = rect.width / rect.height;
  let sx = 0;
  let sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;
  if (sourceRatio > targetRatio) {
    sw = sh * targetRatio;
    sx = (video.videoWidth - sw) / 2;
  } else {
    sh = sw / targetRatio;
    sy = (video.videoHeight - sh) / 2;
  }
  ctx.save();
  if (radius > 0) {
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
    ctx.clip();
  }
  ctx.drawImage(video, sx, sy, sw, sh, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
  return true;
}

/** Which captures to start and stop so every visible widget element has exactly one. */
export function planWidgetCaptureCrops(
  current: ReadonlyMap<string, Element>,
  visible: ReadonlyMap<string, Element>
): { start: string[]; stop: string[] } {
  const start: string[] = [];
  const stop: string[] = [];
  for (const [id, element] of current) {
    if (visible.get(id) !== element) stop.push(id);
  }
  for (const [id, element] of visible) {
    if (current.get(id) !== element) start.push(id);
  }
  return { start, stop };
}
