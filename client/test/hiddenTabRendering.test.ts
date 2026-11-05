import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Chrome stops requestAnimationFrame in hidden tabs and slows it to about
 * 1 fps in covered windows. Anything that feeds the broadcast, the recording
 * or a guest's camera must run on the worker-driven frame ticker instead.
 */
const PROGRAM_PATH_FILES = [
  '../src/hooks/useCompositor.ts',
  '../src/hooks/useVirtualBackground.ts',
  '../src/hooks/useRtmpRelay.ts',
  '../src/utils/relayVideoStream.ts',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('program video never depends on requestAnimationFrame', () => {
  for (const file of PROGRAM_PATH_FILES) {
    it(file.replace('../src/', ''), () => {
      const source = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));
      assert.equal(/requestAnimationFrame\s*\(/.test(source), false, `${file} schedules frames with requestAnimationFrame`);
    });
  }

  it('the camera effects and the relay scaler use the frame ticker', () => {
    for (const file of ['../src/hooks/useVirtualBackground.ts', '../src/utils/relayVideoStream.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.match(source, /createFrameTicker/, file);
    }
  });
});
