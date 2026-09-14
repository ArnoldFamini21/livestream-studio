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
