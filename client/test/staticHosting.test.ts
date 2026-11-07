import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import viteConfig from '../vite.config.ts';

// Hostinger serves .mjs as text/plain, and browsers refuse to run a module
// script with that type. The PDF.js worker is the one .mjs asset.
describe('static hosting', () => {
  it('emits .mjs assets such as the PDF worker as .js', () => {
    const output = (viteConfig as { build: { rollupOptions: { output: { assetFileNames: (info: { names: string[] }) => string } } } })
      .build.rollupOptions.output;
    assert.equal(output.assetFileNames({ names: ['pdf.worker.mjs'] }), 'assets/[name]-[hash].js');
    assert.equal(output.assetFileNames({ names: ['index.css'] }), 'assets/[name]-[hash][extname]');
  });

  it('serves module scripts as JavaScript on Hostinger', () => {
    const htaccess = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8');
    assert.match(htaccess, /^AddType text\/javascript .*\.mjs/m);
  });

  it('serves WebAssembly as application/wasm for streaming compilation', () => {
    const htaccess = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8');
    assert.match(htaccess, /^AddType application\/wasm \.wasm$/m);
  });

  it('keeps the in-browser AI runtimes same-origin, so the CSP needs no new host', () => {
    const htaccess = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8');
    const csp = htaccess.match(/^\s*Header always set Content-Security-Policy "([^"]+)"/m)?.[1] || '';
    const directive = (name: string) => csp.split(';').map((part) => part.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) || [];
    // Whisper and face-model weights are fetched, not executed: connect-src https: covers them.
    assert.ok(directive('connect-src').includes('https:'));
    assert.ok(directive('worker-src').includes("'self'"), 'the Whisper worker is a same-origin module');
    assert.ok(directive('script-src').includes("'wasm-unsafe-eval'"), 'onnxruntime and MediaPipe compile WebAssembly');
    const worker = readFileSync(new URL('../src/workers/transcription.worker.ts', import.meta.url), 'utf8');
    assert.match(worker, /wasmPaths = undefined/, 'onnxruntime uses its bundled glue and same-origin .wasm, not the CDN');
    assert.match(worker, /useWasmCache = false/, 'no blob: module import, which script-src does not allow');
    const vision = readFileSync(new URL('../src/utils/mediapipeVisionAssets.ts', import.meta.url), 'utf8');
    assert.match(vision, /vision_wasm_internal\.js\?url/);
    assert.match(vision, /vision_wasm_internal\.wasm\?url/);
  });

  it('sends a Content-Security-Policy that allows only the script hosts the studio loads', () => {
    const htaccess = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8');
    const match = htaccess.match(/^\s*Header always set Content-Security-Policy "([^"]+)"/m);
    assert.ok(match, 'the CSP header is set');
    const directives = new Map(match[1].split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values] as const;
    }));
    const scriptSrc = directives.get('script-src') || [];
    assert.ok(!scriptSrc.includes("'unsafe-eval'") && !scriptSrc.includes("'unsafe-inline'"), 'no script eval or inline scripts');
    assert.ok(!scriptSrc.includes('https:') && !scriptSrc.includes('*'), 'script hosts are listed one by one');
    for (const host of ["'self'", "'wasm-unsafe-eval'", 'https://accounts.google.com', 'https://apis.google.com', 'https://cdn.jsdelivr.net']) {
      assert.ok(scriptSrc.includes(host), `script-src allows ${host}`);
    }
    // The studio's own source must only load scripts from those hosts.
    const sources = [
      readFileSync(new URL('../src/hooks/useVirtualBackground.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/utils/googleOAuth.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/utils/googleDriveConnection.ts', import.meta.url), 'utf8'),
    ].join('\n');
    for (const [, origin] of sources.matchAll(/'(https:\/\/[^/']+)\/(?:npm|js|gsi)\//g)) {
      assert.ok(scriptSrc.includes(origin), `${origin} is allowed to serve scripts`);
    }
    assert.deepEqual(directives.get('frame-ancestors'), ["'self'"]);
    assert.ok(directives.get('connect-src')?.includes('wss:'), 'signaling and media WebSockets are allowed');
    assert.ok(directives.get('worker-src')?.includes('blob:'), 'MediaPipe and PDF.js workers are allowed');
    assert.ok(directives.get('object-src')?.includes('blob:'), 'the local PDF viewer works');
    assert.match(htaccess, /Permissions-Policy "[^"]*camera=\(self\)[^"]*microphone=\(self\)[^"]*display-capture=\(self\)/);
    assert.match(htaccess, /^RewriteRule \. \/index\.html \[L\]$/m, 'SPA routes fall back to index.html');
  });
});
