import assert from 'node:assert/strict';
import { it } from 'node:test';
import { drawParticipantCards } from '../src/utils/compositorParticipantCards.ts';

function renderCard(displayScale: number, cameraOff: boolean) {
  const fills: unknown[][] = [];
  const texts: string[] = [];
  const colors: string[] = [];
  const bounds = { left: 40, top: 70 } as DOMRect;
  const box = { left: 40 + 20 * displayScale, top: 70 + 20 * displayScale, width: 216 * displayScale, height: 121.5 * displayScale };
  const initials = { getBoundingClientRect: () => box, textContent: 'AF' };
  const placeholder = {
    dataset: { stagePlaceholder: 'Arnold Famini' },
    getBoundingClientRect: () => box,
    querySelectorAll: (selector: string) => selector === '[data-stage-avatar-text]' ? [initials] : [],
  };
  const tile = {
    getBoundingClientRect: () => box,
    querySelector: (selector: string) => selector === '[data-stage-placeholder]' && cameraOff ? placeholder : null,
  };
  const stage = { querySelectorAll: () => [tile] } as unknown as HTMLElement;
  const ctx = {
    save() {}, restore() {}, beginPath() {}, clip() {}, roundRect() {}, rect() {},
    createLinearGradient: () => ({ addColorStop: (_offset: number, color: string) => colors.push(color) }),
    fillRect: (...args: unknown[]) => fills.push(args),
    fillText: (text: string) => texts.push(text),
  } as unknown as CanvasRenderingContext2D;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ borderTopLeftRadius: '8px', color: '#fff', fontWeight: '700', fontSize: '22px', fontFamily: 'sans-serif' }) });
  try {
    drawParticipantCards(ctx, stage, bounds, 2 / displayScale, 2 / displayScale, 2, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'getComputedStyle', original);
    else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
  return { fills, texts, colors };
}

it('includes a camera-off presenter in the recorded composition', () => {
  const result = renderCard(1, true);
  assert.deepEqual(result.fills, [[40, 40, 432, 243]]);
  assert.deepEqual(result.texts, ['AF']);
  assert.equal(result.colors.length, 2);
});

it('keeps the recorded card fixed when a sidebar scales the preview', () => {
  assert.deepEqual(renderCard(0.5, true), renderCard(1, true));
});

it('does not cover a live camera with an avatar card', () => {
  const result = renderCard(1, false);
  assert.deepEqual(result.fills, []);
  assert.deepEqual(result.texts, []);
});

it('leaves the studio-only "(You)" out of the broadcast name tag', () => {
  const texts: string[] = [];
  const pills: number[][] = [];
  const bounds = { left: 0, top: 0 } as DOMRect;
  const at = (left: number, width: number) => ({ getBoundingClientRect: () => ({ left, top: 100, width, height: 24 }) });
  const name = { nodeType: 3, textContent: 'Arnold', childNodes: [] };
  const you = { ...at(160, 44), textContent: ' (You)', childNodes: [], hasAttribute: (attr: string) => attr === 'data-local-only' };
  const text = { ...at(100, 104), textContent: 'Arnold (You)', childNodes: [name, you], hasAttribute: () => false };
  const tag = { ...at(90, 124), querySelector: (selector: string) => selector === '[data-stage-name-text]' ? text : null, querySelectorAll: (selector: string) => selector === '[data-local-only]' ? [you] : [] };
  const tile = { ...at(0, 400), querySelector: (selector: string) => selector === '[data-stage-name-tag]' ? tag : null };
  const stage = { querySelectorAll: () => [tile] } as unknown as HTMLElement;
  const ctx = {
    save() {}, restore() {}, beginPath() {}, clip() {}, rect() {}, fill() {},
    roundRect: (...args: number[]) => pills.push(args),
    fillText: (value: string) => texts.push(value),
  } as unknown as CanvasRenderingContext2D;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ borderTopLeftRadius: '12px', color: '#fff', backgroundColor: '#000', fontWeight: '600', fontSize: '14px', fontFamily: 'sans-serif' }) });
  try {
    drawParticipantCards(ctx, stage, bounds, 1, 1, 1, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'getComputedStyle', original);
    else delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  }
  assert.deepEqual(texts, ['Arnold']);
  assert.equal(pills[1][2], 124 - 44, 'the pill (after the tile outline) is trimmed by the width of "(You)"');
});
