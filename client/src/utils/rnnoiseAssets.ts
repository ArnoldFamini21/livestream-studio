// Same-origin URLs of the RNNoise WebAssembly builds (MIT, from
// @sapphi-red/web-noise-suppressor). Vite emits each as a hashed asset, so the
// binary is served from 'self' and allowed by the production CSP; no CDN.
// Only the URL strings live in this module, and it is imported dynamically,
// so nothing is downloaded until AI noise removal is switched on.
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export { rnnoiseWasmUrl, rnnoiseSimdWasmUrl };
