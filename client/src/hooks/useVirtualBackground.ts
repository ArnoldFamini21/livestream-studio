import { useEffect, useRef, useState } from 'react';
// Types only — the runtime is loaded lazily from CDN so we don't bake the
// ~3MB MediaPipe bundle into the main app chunk.
import type { SelfieSegmentation as SelfieSegmentationType, Results } from '@mediapipe/selfie_segmentation';
import {
  DEFAULT_CHROMA_KEY_COLOR,
  DEFAULT_CHROMA_SIMILARITY,
  normalizeChromaKeyColor,
  normalizeChromaSimilarity,
} from '../utils/virtualBackgrounds.ts';
import {
  buildFallbackBackgroundFilter,
  buildReplacementBackgroundFilter,
  getExpandedDrawRect,
  getVirtualBackgroundRefinementSettings,
  prepareSegmentationMaskAlpha,
} from '../utils/virtualBackgroundRefinement.ts';

declare global {
  interface Window {
    SelfieSegmentation?: new (config?: { locateFile?: (path: string) => string }) => SelfieSegmentationType;
  }
}

export type VirtualBackgroundMode = 'off' | 'blur' | 'image' | 'green-screen';

export interface VirtualBackgroundConfig {
  mode: VirtualBackgroundMode;
  // Required when mode === 'image'; optional replacement when mode === 'green-screen'.
  imageSrc?: string;
  // Blur radius in CSS pixels when mode === 'blur'. Default 12.
  blurPx?: number;
  // Chroma key controls when mode === 'green-screen'.
  keyColor?: string;
  similarity?: number;
}

interface UseVirtualBackgroundInput {
  inputStream: MediaStream | null;
  config: VirtualBackgroundConfig;
}

interface UseVirtualBackgroundResult {
  // The effective stream the rest of the app should consume. Identical to
  // inputStream when mode === 'off' or while segmentation is still warming up.
  outputStream: MediaStream | null;
  ready: boolean;
  error: string | null;
}

const MEDIAPIPE_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747';

// Cached script-load promise so concurrent toggles only trigger one network fetch.
let mediapipeLoadPromise: Promise<void> | null = null;
function loadMediaPipeScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.SelfieSegmentation) return Promise.resolve();
  if (mediapipeLoadPromise) return mediapipeLoadPromise;
  mediapipeLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-mediapipe-selfie]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load MediaPipe')));
      return;
    }
    const script = document.createElement('script');
    script.src = `${MEDIAPIPE_BASE}/selfie_segmentation.js`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.mediapipeSelfie = 'true';
    script.onload = () => resolve();
    script.onerror = () => {
      mediapipeLoadPromise = null;
      reject(new Error('Failed to load MediaPipe selfie_segmentation script'));
    };
    document.head.appendChild(script);
  });
  return mediapipeLoadPromise;
}

// Reasonable target FPS for the compositor. Lowering this saves CPU while still
// looking smooth for talking-head video. Most webcams cap around 30 anyway.
const TARGET_FPS = 30;

/**
 * Apply a virtual background to a webcam stream. Blur and image replacement use
 * MediaPipe Selfie Segmentation; green screen mode uses a local chroma key
 * canvas path. The returned outputStream contains the original audio tracks
 * plus a canvas-captured video track that downstream code can consume
 * transparently.
 */
export function useVirtualBackground({
  inputStream,
  config,
}: UseVirtualBackgroundInput): UseVirtualBackgroundResult {
  const [outputStream, setOutputStream] = useState<MediaStream | null>(inputStream);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs that don't trigger re-renders for the per-frame loop.
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // Cached HTMLImageElement so we don't re-decode the data URL on every frame.
  const bgImageRef = useRef<{ src: string; img: HTMLImageElement | null } | null>(null);

  useEffect(() => {
    if (!['image', 'green-screen'].includes(config.mode) || !config.imageSrc) {
      bgImageRef.current = null;
      return;
    }
    if (bgImageRef.current?.src === config.imageSrc) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      bgImageRef.current = { src: config.imageSrc!, img };
    };
    img.onerror = () => {
      bgImageRef.current = { src: config.imageSrc!, img: null };
      console.warn('Failed to load virtual background image');
    };
    img.src = config.imageSrc;
  }, [config.mode, config.imageSrc]);

  // Bypass entirely when off — return the raw stream unchanged.
  useEffect(() => {
    if (config.mode === 'off') {
      setOutputStream(inputStream);
      setReady(true);
      setError(null);
    }
  }, [config.mode, inputStream]);

  useEffect(() => {
    if (config.mode !== 'green-screen') return;
    if (!inputStream) {
      setOutputStream(null);
      setReady(false);
      return;
    }

    const videoTrack = inputStream.getVideoTracks()[0];
    if (!videoTrack) {
      setOutputStream(inputStream);
      setReady(true);
      setError(null);
      return;
    }

    setOutputStream(inputStream);
    setReady(false);

    let cancelled = false;
    let raf = 0;
    let composed: MediaStream | null = null;

    const driverVideo = document.createElement('video');
    driverVideo.muted = true;
    driverVideo.playsInline = true;
    driverVideo.srcObject = new MediaStream([videoTrack]);

    const outputCanvas = document.createElement('canvas');
    const outputCtx = outputCanvas.getContext('2d');
    const sourceCanvas = document.createElement('canvas');
    const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!outputCtx || !sourceCtx) {
      setError('Canvas 2D context unavailable; cannot apply green screen.');
      setOutputStream(inputStream);
      setReady(false);
      driverVideo.srcObject = null;
      return;
    }

    const finalize = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      try { driverVideo.pause(); } catch { /* ignore */ }
      driverVideo.srcObject = null;
      composed?.getVideoTracks().forEach((track) => track.stop());
      composed = null;
    };

    const sizeCanvasesToTrack = () => {
      const settings = videoTrack.getSettings();
      const w = settings.width || driverVideo.videoWidth || 1280;
      const h = settings.height || driverVideo.videoHeight || 720;
      if (outputCanvas.width !== w || outputCanvas.height !== h) {
        outputCanvas.width = w;
        outputCanvas.height = h;
        sourceCanvas.width = w;
        sourceCanvas.height = h;
      }
    };

    const drawChromaComposite = () => {
      const cw = outputCanvas.width;
      const ch = outputCanvas.height;
      const { r, g, b } = parseHexColor(configRef.current.keyColor ?? DEFAULT_CHROMA_KEY_COLOR);
      const similarity = normalizeChromaSimilarity(configRef.current.similarity ?? DEFAULT_CHROMA_SIMILARITY);

      sourceCtx.clearRect(0, 0, cw, ch);
      sourceCtx.drawImage(driverVideo, 0, 0, cw, ch);
      const frame = sourceCtx.getImageData(0, 0, cw, ch);
      applyChromaKey(frame.data, r, g, b, similarity);

      outputCtx.save();
      outputCtx.clearRect(0, 0, cw, ch);
      outputCtx.putImageData(frame, 0, 0);
      outputCtx.globalCompositeOperation = 'destination-over';
      const cached = bgImageRef.current?.img;
      if (cached && cached.complete && cached.naturalWidth > 0) {
        drawCover(outputCtx, cached, cw, ch);
      } else {
        outputCtx.fillStyle = '#0f172a';
        outputCtx.fillRect(0, 0, cw, ch);
      }
      outputCtx.restore();
    };

    const frameInterval = 1000 / TARGET_FPS;
    let lastFrameTime = 0;

    const renderLoop = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(renderLoop);
      if (now - lastFrameTime < frameInterval || driverVideo.readyState < 2) return;
      lastFrameTime = now;
      sizeCanvasesToTrack();
      drawChromaComposite();
    };

    (async () => {
      try {
        await driverVideo.play();
        if (cancelled) {
          finalize();
          return;
        }

        sizeCanvasesToTrack();
        drawChromaComposite();
        const captured = outputCanvas.captureStream(TARGET_FPS);
        composed = new MediaStream();
        for (const track of inputStream.getAudioTracks()) composed.addTrack(track);
        for (const track of captured.getVideoTracks()) composed.addTrack(track);
        setOutputStream(composed);
        setReady(true);
        setError(null);

        raf = requestAnimationFrame(renderLoop);
      } catch (err) {
        console.error('Failed to initialize green screen:', err);
        setError(err instanceof Error ? err.message : 'Green screen failed to start');
        setReady(false);
        setOutputStream(inputStream);
        finalize();
      }
    })();

    return () => {
      finalize();
    };
  }, [inputStream, config.mode]);

  useEffect(() => {
    if (config.mode === 'off' || config.mode === 'green-screen') return;
    if (!inputStream) {
      setOutputStream(null);
      setReady(false);
      return;
    }

    // While we boot the segmenter, surface the raw stream so the local preview
    // and peers keep showing the camera instead of freezing.
    setOutputStream(inputStream);
    setReady(false);

    const videoTrack = inputStream.getVideoTracks()[0];
    if (!videoTrack) {
      // Audio-only: passthrough.
      setOutputStream(inputStream);
      setReady(true);
      return;
    }

    let cancelled = false;
    let raf = 0;
    let segmenter: SelfieSegmentationType | null = null;
    let lastResults: Results | null = null;
    let inFlight = false;

    // The driver video element pulls frames from the input track.
    const driverVideo = document.createElement('video');
    driverVideo.muted = true;
    driverVideo.playsInline = true;
    driverVideo.srcObject = new MediaStream([videoTrack]);

    // Output canvas — captureStream from this is what we hand to consumers.
    const outputCanvas = document.createElement('canvas');
    const outputCtx = outputCanvas.getContext('2d', { alpha: false });
    if (!outputCtx) {
      setError('Canvas 2D context unavailable; cannot apply virtual background.');
      return;
    }

    const foregroundCanvas = document.createElement('canvas');
    const foregroundCtx = foregroundCanvas.getContext('2d');
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!foregroundCtx || !maskCtx) {
      setError('Canvas 2D context unavailable; cannot apply virtual background foreground.');
      setOutputStream(inputStream);
      return;
    }

    const finalize = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      try { driverVideo.pause(); } catch { /* ignore */ }
      driverVideo.srcObject = null;
      if (segmenter) {
        // close() returns a promise; we don't await it on unmount.
        segmenter.close().catch(() => { /* ignore */ });
        segmenter = null;
      }
    };

    const sizeCanvasToTrack = () => {
      const settings = videoTrack.getSettings();
      const w = settings.width || driverVideo.videoWidth || 1280;
      const h = settings.height || driverVideo.videoHeight || 720;
      if (outputCanvas.width !== w || outputCanvas.height !== h) {
        outputCanvas.width = w;
        outputCanvas.height = h;
        foregroundCanvas.width = w;
        foregroundCanvas.height = h;
        maskCanvas.width = w;
        maskCanvas.height = h;
      }
    };

    const drawBlurredCameraBackground = (
      ctx: CanvasRenderingContext2D,
      image: CanvasImageSource,
      cw: number,
      ch: number,
      blurPx: number
    ) => {
      const refinement = getVirtualBackgroundRefinementSettings(cw, ch);
      const rect = getExpandedDrawRect(cw, ch, Math.max(blurPx, refinement.edgeBlurPx) * 2);
      ctx.save();
      ctx.filter = buildFallbackBackgroundFilter(blurPx, refinement);
      ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      ctx.filter = 'none';
      ctx.restore();
    };

    const drawReplacementBackground = (
      ctx: CanvasRenderingContext2D,
      image: CanvasImageSource,
      cw: number,
      ch: number,
      mode: VirtualBackgroundMode
    ) => {
      const refinement = getVirtualBackgroundRefinementSettings(cw, ch);
      if (mode === 'blur') {
        drawBlurredCameraBackground(ctx, image, cw, ch, configRef.current.blurPx ?? 12);
        return;
      }

      if (mode !== 'image') return;
      const cached = bgImageRef.current?.img;
      if (cached && cached.complete && cached.naturalWidth > 0) {
        ctx.save();
        ctx.filter = buildReplacementBackgroundFilter(refinement);
        drawCover(ctx, cached, cw, ch, refinement.replacementBackgroundBlurPx * 3);
        ctx.filter = 'none';
        ctx.restore();
      } else {
        drawBlurredCameraBackground(ctx, image, cw, ch, 16);
      }
    };

    const drawNativeForegroundMask = (
      segmentationMask: CanvasImageSource,
      cw: number,
      ch: number
    ) => {
      maskCtx.save();
      maskCtx.clearRect(0, 0, cw, ch);
      maskCtx.imageSmoothingEnabled = true;
      maskCtx.imageSmoothingQuality = 'high';
      maskCtx.drawImage(segmentationMask, 0, 0, cw, ch);
      maskCtx.restore();
    };

    const drawRefinedForegroundMask = (
      segmentationMask: CanvasImageSource,
      cw: number,
      ch: number
    ): boolean => {
      try {
        drawNativeForegroundMask(segmentationMask, cw, ch);
        const maskFrame = maskCtx.getImageData(0, 0, cw, ch);
        prepareSegmentationMaskAlpha(maskFrame.data, cw, ch);
        maskCtx.putImageData(maskFrame, 0, 0);
        return true;
      } catch {
        return false;
      }
    };

    const drawForeground = (
      ctx: CanvasRenderingContext2D,
      image: CanvasImageSource,
      segmentationMask: CanvasImageSource,
      cw: number,
      ch: number
    ) => {
      const refinement = getVirtualBackgroundRefinementSettings(cw, ch);
      const refinedMask = drawRefinedForegroundMask(segmentationMask, cw, ch);
      if (!refinedMask) drawNativeForegroundMask(segmentationMask, cw, ch);

      foregroundCtx.save();
      foregroundCtx.clearRect(0, 0, cw, ch);
      foregroundCtx.imageSmoothingEnabled = true;
      foregroundCtx.imageSmoothingQuality = 'high';
      foregroundCtx.drawImage(image, 0, 0, cw, ch);
      foregroundCtx.globalCompositeOperation = 'destination-in';
      foregroundCtx.drawImage(maskCanvas, 0, 0, cw, ch);
      foregroundCtx.globalCompositeOperation = 'source-over';
      foregroundCtx.restore();

      ctx.save();
      ctx.globalAlpha = refinement.edgeFeatherOpacity;
      ctx.filter = `blur(${Math.max(1, refinement.edgeBlurPx * 0.72)}px)`;
      ctx.drawImage(
        foregroundCanvas,
        -refinement.maskExpansionPx,
        -refinement.maskExpansionPx,
        cw + refinement.maskExpansionPx * 2,
        ch + refinement.maskExpansionPx * 2
      );
      ctx.restore();

      ctx.drawImage(foregroundCanvas, 0, 0, cw, ch);
    };

    const drawComposite = () => {
      if (!lastResults) return;
      const { segmentationMask, image } = lastResults;
      const ctx = outputCtx;
      const cw = outputCanvas.width;
      const ch = outputCanvas.height;
      const mode = configRef.current.mode;

      ctx.save();
      ctx.clearRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      drawReplacementBackground(ctx, image, cw, ch, mode);
      drawForeground(ctx, image, segmentationMask, cw, ch);
      ctx.restore();
    };

    const frameInterval = 1000 / TARGET_FPS;
    let lastFrameTime = 0;

    const renderLoop = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(renderLoop);

      if (now - lastFrameTime < frameInterval) return;
      lastFrameTime = now;

      if (driverVideo.readyState < 2 || !segmenter || inFlight) return;
      sizeCanvasToTrack();

      inFlight = true;
      segmenter
        .send({ image: driverVideo })
        .catch((err) => console.warn('Segmentation frame failed:', err))
        .finally(() => { inFlight = false; });
    };

    (async () => {
      try {
        await loadMediaPipeScript();
        if (cancelled) return;
        const Ctor = window.SelfieSegmentation;
        if (!Ctor) throw new Error('MediaPipe loaded but constructor missing');

        segmenter = new Ctor({
          locateFile: (file) => `${MEDIAPIPE_BASE}/${file}`,
        });
        segmenter.setOptions({ modelSelection: 1, selfieMode: false });
        segmenter.onResults((results) => {
          lastResults = results;
          drawComposite();
        });
        await segmenter.initialize();

        await driverVideo.play();
        if (cancelled) {
          finalize();
          return;
        }

        sizeCanvasToTrack();

        // Capture once the canvas has its first frame painted.
        const captured = outputCanvas.captureStream(TARGET_FPS);
        const composed = new MediaStream();
        for (const t of inputStream.getAudioTracks()) composed.addTrack(t);
        for (const t of captured.getVideoTracks()) composed.addTrack(t);
        setOutputStream(composed);
        setReady(true);
        setError(null);

        raf = requestAnimationFrame(renderLoop);
      } catch (err) {
        console.error('Failed to initialize virtual background:', err);
        setError(err instanceof Error ? err.message : 'Virtual background failed to start');
        setReady(false);
        // On failure, fall back to the raw stream so the user isn't blocked.
        setOutputStream(inputStream);
        finalize();
      }
    })();

    return () => {
      finalize();
    };
    // We intentionally re-spin the pipeline when the input stream changes or
    // when the mode toggles between off and on.
  }, [inputStream, config.mode]);

  return { outputStream, ready, error };
}

// "background-size: cover" style draw onto a canvas.
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  bleedPx = 0
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const targetW = w + Math.max(0, bleedPx) * 2;
  const targetH = h + Math.max(0, bleedPx) * 2;
  const scale = Math.max(targetW / iw, targetH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function parseHexColor(color: string) {
  const normalized = normalizeChromaKeyColor(color);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function applyChromaKey(
  data: Uint8ClampedArray,
  keyR: number,
  keyG: number,
  keyB: number,
  similarity: number
) {
  const softness = 0.08;
  for (let i = 0; i < data.length; i += 4) {
    const dr = (data[i] - keyR) / 255;
    const dg = (data[i + 1] - keyG) / 255;
    const db = (data[i + 2] - keyB) / 255;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);

    if (distance <= similarity) {
      data[i + 3] = 0;
    } else if (distance <= similarity + softness) {
      data[i + 3] = Math.round(data[i + 3] * ((distance - similarity) / softness));
    }
  }
}
