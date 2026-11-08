import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { sanitizeClientErrorRelease } from '../shared/src/clientErrors.ts';

function buildRelease(): string {
  const configured = sanitizeClientErrorRelease(process.env.VITE_RELEASE) ?? sanitizeClientErrorRelease(process.env.GITHUB_SHA);
  if (configured) return configured;
  try {
    return sanitizeClientErrorRelease(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) ?? '';
  } catch { return ''; }
}

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_RELEASE': JSON.stringify(buildRelease()) },
  // Module workers: the in-browser Whisper worker (transformers.js) is split
  // into chunks, which the default IIFE worker format cannot do.
  worker: {
    format: 'es',
  },
  build: {
    // Never inline AudioWorklet modules as data: URLs. The production CSP
    // (public/.htaccess) only lets scripts and worklets load from 'self'.
    assetsInlineLimit: (filePath) => (/\.worklet\.js$/.test(filePath) ? false : undefined),
    rollupOptions: {
      output: {
        // Emit .mjs assets (the PDF.js worker) as .js. Static hosts such as
        // Hostinger serve .mjs as text/plain, and browsers refuse to run a
        // module script with that type, so PDFs could not render.
        assetFileNames(assetInfo) {
          const name = assetInfo.names?.[0] ?? '';
          return name.endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]';
        },
        manualChunks(id) {
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router-dom/')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
