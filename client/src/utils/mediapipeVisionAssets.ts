// Same-origin URLs of the MediaPipe Tasks Vision WebAssembly runtime
// (@mediapipe/tasks-vision, Apache-2.0). Vite emits both as hashed assets, so
// the loader script and binary are served from 'self' and allowed by the
// production CSP (script-src 'self' 'wasm-unsafe-eval'); no CDN. Only the URL
// strings live here, and this module is imported dynamically, so nothing is
// downloaded until a smart-framed clip is exported.
import visionWasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import visionWasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

/**
 * BlazeFace short-range face detector (for faces within ~2 m, i.e. webcams).
 * Fetched from Google's model bucket, allowed by connect-src https:.
 */
export const FACE_DETECTOR_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

export { visionWasmLoaderUrl, visionWasmBinaryUrl };
