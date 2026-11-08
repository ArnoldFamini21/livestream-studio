/**
 * Web widgets are cross-origin iframes, which a canvas cannot read, so the
 * program draws a placeholder for them. In Chromium the host can opt in to
 * capturing this tab (getDisplayMedia with preferCurrentTab) and limiting the
 * capture to each widget's element. Each widget gets its own clone of the one
 * capture, played in a detached <video> the compositor draws into the
 * widget's box. Everything runs in the browser; nothing is uploaded.
 *
 * Element Capture (RestrictionTarget.fromElement + track.restrictTo, Chrome
 * 132+) is used whenever it exists: it captures only the widget's own
 * subtree, so a dialog, toast or green-room prompt drawn over the widget never
 * reaches viewers. Region Capture (CropTarget.fromElement + track.cropTo) is
 * the fallback; it crops to the element's box and takes whatever is painted
 * there, so the host is warned that overlapping studio UI will be broadcast.
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
  RestrictionTarget?: { fromElement?: unknown };
  BrowserCaptureMediaStreamTrack?: { prototype?: { cropTo?: unknown; restrictTo?: unknown } };
  isSecureContext?: boolean;
}

/** How a capture clone is limited to a widget. */
export type WidgetCaptureMethod = 'element' | 'region';

/** Shown while Region Capture is in use: it takes whatever is painted over the widget. */
export const WIDGET_REGION_CAPTURE_WARNING =
  'This browser can only crop the tab to each widget, so anything shown on top of a widget (a dialog, a toast, a guest waiting to be let in) is broadcast too. Update Chrome or Edge to capture just the widget.';

function hasElementCapture(scope: CaptureGlobals): boolean {
  return typeof scope.RestrictionTarget?.fromElement === 'function'
    && typeof scope.BrowserCaptureMediaStreamTrack?.prototype?.restrictTo === 'function';
}

function hasRegionCapture(scope: CaptureGlobals): boolean {
  return typeof scope.CropTarget?.fromElement === 'function'
    && typeof scope.BrowserCaptureMediaStreamTrack?.prototype?.cropTo === 'function';
}

/** Element Capture (Chrome/Edge 132+) or, failing that, Region Capture (104+); Chromium desktop only. */
export function getWidgetTabCaptureSupport(scope: CaptureGlobals = globalThis as unknown as CaptureGlobals): WidgetCaptureSupport & { method: WidgetCaptureMethod | null } {
  if (scope.isSecureContext === false) return { supported: false, reason: 'Tab capture needs a secure (https) page.', method: null };
  if (typeof scope.navigator?.mediaDevices?.getDisplayMedia !== 'function') {
    return { supported: false, reason: 'This browser cannot capture a tab.', method: null };
  }
  if (hasElementCapture(scope)) return { supported: true, reason: null, method: 'element' };
  if (hasRegionCapture(scope)) return { supported: true, reason: null, method: 'region' };
  return { supported: false, reason: 'Widget capture needs Chrome or Edge on a computer.', method: null };
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
  cropTo?(target: unknown): Promise<void>;
  restrictTo?(target: unknown): Promise<void>;
}

interface TargetFactory {
  fromElement(element: Element): Promise<unknown>;
}

export interface CaptureTargetFactories {
  RestrictionTarget?: TargetFactory;
  CropTarget?: TargetFactory;
}

function globalTargetFactories(): CaptureTargetFactories {
  const scope = globalThis as unknown as CaptureTargetFactories;
  return { RestrictionTarget: scope.RestrictionTarget, CropTarget: scope.CropTarget };
}

/**
 * Limits a capture clone to one element of the captured tab. Element Capture
 * first (only the element's own pixels); Region Capture when Element Capture
 * is missing or refuses this element. Returns the method that was applied.
 */
export async function limitTrackToElement(
  track: MediaStreamTrack,
  element: Element,
  factories: CaptureTargetFactories = globalTargetFactories()
): Promise<WidgetCaptureMethod> {
  const capable = track as CropCapableTrack;
  if (typeof factories.RestrictionTarget?.fromElement === 'function' && typeof capable.restrictTo === 'function') {
    try {
      const target = await factories.RestrictionTarget.fromElement(element);
      await capable.restrictTo(target);
      return 'element';
    } catch (error) {
      if (typeof factories.CropTarget?.fromElement !== 'function' || typeof capable.cropTo !== 'function') throw error;
    }
  }
  if (typeof factories.CropTarget?.fromElement !== 'function' || typeof capable.cropTo !== 'function') {
    throw new Error('This browser cannot limit a tab capture to an element.');
  }
  const target = await factories.CropTarget.fromElement(element);
  await capable.cropTo(target);
  return 'region';
}

/** Region Capture only (kept for callers that need the box crop explicitly). */
export async function cropTrackToElement(
  track: MediaStreamTrack,
  element: Element,
  cropTarget: TargetFactory = (globalThis as unknown as { CropTarget: TargetFactory }).CropTarget
): Promise<void> {
  await limitTrackToElement(track, element, { CropTarget: cropTarget });
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
