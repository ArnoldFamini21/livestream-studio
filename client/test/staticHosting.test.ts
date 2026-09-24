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
});
