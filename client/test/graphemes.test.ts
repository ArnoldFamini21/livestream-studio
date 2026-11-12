import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitCodePoints, splitGraphemes } from '../src/utils/graphemes.ts';

const ZWJ = String.fromCodePoint(0x200d);
const FAMILY = ['\u{1F468}', '\u{1F469}', '\u{1F467}'].join(ZWJ);
const ACUTE = String.fromCodePoint(0x0301);
const FLAG = '\u{1F1F5}\u{1F1ED}';
const PRAYING = '\u{1F64F}\u{1F3FD}';

describe('splitGraphemes', () => {
  it('keeps a flag, a skin tone emoji and a family emoji in one piece', () => {
    assert.deepEqual(splitGraphemes(`${FLAG}${FLAG}`), [FLAG, FLAG]);
    assert.deepEqual(splitGraphemes(`a${PRAYING}b`), ['a', PRAYING, 'b']);
    assert.deepEqual(splitGraphemes(`x${FAMILY}`), ['x', FAMILY]);
  });

  it('keeps a letter with its accent together', () => {
    const accented = `e${ACUTE}`;
    assert.deepEqual(splitGraphemes(`${accented}a`), [accented, 'a']);
  });

  it('handles plain and empty text, and the code point fallback splits only by code point', () => {
    assert.deepEqual(splitGraphemes('abc'), ['a', 'b', 'c']);
    assert.deepEqual(splitGraphemes(''), []);
    assert.deepEqual(splitCodePoints(`${FLAG}`), ['\u{1F1F5}', '\u{1F1ED}']);
  });
});
