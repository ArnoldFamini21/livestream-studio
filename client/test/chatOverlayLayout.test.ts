import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHAT_OVERLAY_ABSOLUTE_MAX_ROWS,
  CHAT_OVERLAY_MAX_LINES,
  createChatOverlayLayoutCache,
  getChatOverlayInsetCss,
  layoutChatOverlay,
  wrapOverlayText,
  type ChatOverlayLayoutSettings,
  type TextMeasure,
} from '../src/utils/chatOverlayLayout.ts';
import { drawChatOverlay } from '../src/utils/chatOverlayCanvas.ts';
import type { ChatOverlayComment } from '../src/utils/chatOverlayComments.ts';

const FAMILY = 'Inter, Arial, sans-serif';
let measureCalls = 0;
const measure: TextMeasure = (font, text) => {
  measureCalls += 1;
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 16;
  return Array.from(text).length * px * 0.5;
};

function comment(id: string, text: string, extra: Partial<ChatOverlayComment> = {}): ChatOverlayComment {
  return { id, author: 'Maria', text, question: false, source: 'studio', at: 0, ...extra };
}
const settings = (overrides: Partial<ChatOverlayLayoutSettings> = {}): ChatOverlayLayoutSettings => ({ size: 'm', layout: 'regular', side: 'left', ...overrides });
const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const run = (comments: ChatOverlayComment[], s = settings(), canvas = LANDSCAPE, bottomInset = 0) =>
  layoutChatOverlay({ comments, settings: s, canvas, bottomInset, fontFamily: FAMILY, measure });

const some = (count: number) => Array.from({ length: count }, (_, i) => comment(`c${i}`, `Comment number ${i} with a few words in it`));

describe('layoutChatOverlay', () => {
  it('draws nothing for no comments', () => {
    const result = run([]);
    assert.equal(result.primitives.length, 0);
    assert.equal(result.bounds, null);
  });

  it('is pure: the same inputs give the same primitives', () => {
    assert.deepEqual(run(some(4)), run(some(4)));
  });

  it('keeps every card inside the canvas in landscape and portrait, on both sides, for every size and layout', () => {
    for (const canvas of [LANDSCAPE, PORTRAIT]) {
      for (const side of ['left', 'right'] as const) {
        for (const size of ['s', 'm', 'l'] as const) {
          for (const layout of ['regular', 'tall', 'wide'] as const) {
            const result = run(some(12), settings({ side, size, layout }), canvas, 90);
            assert.ok(result.bounds, `${canvas.width} ${side} ${size} ${layout}`);
            const { x, y, width, height } = result.bounds!;
            assert.ok(x >= 0 && y >= 0 && x + width <= canvas.width && y + height <= canvas.height, `${canvas.width}x${canvas.height} ${side} ${size} ${layout}: ${JSON.stringify(result.bounds)}`);
            assert.ok(result.rows.length <= CHAT_OVERLAY_ABSOLUTE_MAX_ROWS);
          }
        }
      }
    }
  });

  it('anchors to the bottom of the chosen side, newest comment lowest', () => {
    const left = run(some(3), settings({ side: 'left' }));
    const right = run(some(3), settings({ side: 'right' }));
    assert.ok(left.bounds!.x < LANDSCAPE.width / 2);
    assert.ok(right.bounds!.x + right.bounds!.width > LANDSCAPE.width / 2);
    assert.ok(Math.abs((right.bounds!.x + right.bounds!.width) - (LANDSCAPE.width - left.bounds!.x)) < 0.001, 'mirrored margins');
    assert.deepEqual(left.rows.map((row) => row.id), ['c0', 'c1', 'c2']);
    assert.ok(left.rows[2].y > left.rows[0].y);
    assert.ok(left.bounds!.y + left.bounds!.height <= LANDSCAPE.height - 40 + 0.001);
  });

  it('grows with size S, M, L and changes shape with regular, tall and wide', () => {
    const width = (s: Partial<ChatOverlayLayoutSettings>) => run(some(6), settings(s)).bounds!.width;
    assert.ok(width({ size: 's' }) < width({ size: 'm' }));
    assert.ok(width({ size: 'm' }) < width({ size: 'l' }));
    assert.ok(width({ layout: 'tall' }) < width({ layout: 'regular' }));
    assert.ok(width({ layout: 'regular' }) < width({ layout: 'wide' }));
    const rows = (layout: 'regular' | 'tall' | 'wide') => run(some(12), settings({ layout })).rows.length;
    assert.ok(rows('wide') <= 4);
    assert.ok(rows('regular') <= rows('tall'));
    assert.ok(rows('tall') >= 5);
  });

  it('scales with the canvas: the same layout in portrait uses the same relative sizes', () => {
    const landscape = run(some(3));
    const portrait = run(some(3), settings(), PORTRAIT);
    assert.equal(landscape.rows[0].width, portrait.rows[0].width, 'card width follows the 1080 short side');
    assert.equal(portrait.canvas.height, 1920);
    assert.ok(portrait.bounds!.y > 1920 / 2, 'sits in the lower half of a tall canvas');
  });

  it('lifts the overlay by the bottom inset', () => {
    const low = run(some(2), settings(), LANDSCAPE, 0);
    const lifted = run(some(2), settings(), LANDSCAPE, 120);
    assert.ok(Math.abs((low.bounds!.y - lifted.bounds!.y) - 120) < 0.001);
    assert.equal(getChatOverlayInsetCss({ banner: false, ticker: false, lowerThird: false }), 0);
    assert.ok(getChatOverlayInsetCss({ banner: false, ticker: false, lowerThird: true }) > getChatOverlayInsetCss({ banner: false, ticker: true, lowerThird: false }));
  });

  it('wraps long text into at most three lines with an ellipsis and never overflows the card', () => {
    const long = comment('long', 'word '.repeat(80).trim());
    const result = run([long]);
    assert.equal(result.rows[0].lines, CHAT_OVERLAY_MAX_LINES);
    const texts = result.primitives.filter((p) => p.kind === 'text' && p.weight === 400);
    assert.equal(texts.length, CHAT_OVERLAY_MAX_LINES);
    assert.ok((texts.at(-1) as { text: string }).text.endsWith('…'));
    const card = result.rows[0];
    for (const p of texts) assert.ok(measure(`400 ${(p as { fontSize: number }).fontSize}px ${FAMILY}`, (p as { text: string }).text) <= card.width);
  });

  it('breaks an unbroken long word by characters', () => {
    const lines = wrapOverlayText('a'.repeat(120), '400 20px Inter', 200, 3, measure);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => measure('400 20px Inter', line) <= 200));
  });

  it('marks a question with a label', () => {
    const plain = run([comment('a', 'Amen')]);
    const asked = run([comment('a', 'What time is it?', { question: true })]);
    const labels = (r: typeof plain) => r.primitives.filter((p) => p.kind === 'text' && p.text === 'Question');
    assert.equal(labels(plain).length, 0);
    assert.equal(labels(asked).length, 1);
    assert.equal(asked.rows[0].question, true);
  });

  it('colors the accent bar by source', () => {
    const fills = (source: ChatOverlayComment['source']) => run([comment('a', 'hi', { source })]).primitives.filter((p) => p.kind === 'rect')[1];
    assert.notEqual((fills('youtube') as { fill: string }).fill, (fills('studio') as { fill: string }).fill);
    assert.notEqual((fills('facebook') as { fill: string }).fill, (fills('youtube') as { fill: string }).fill);
  });

  it('reports how many comments did not fit', () => {
    const result = run(some(12), settings({ layout: 'wide' }));
    assert.equal(result.rows.length + result.omitted, 12);
    assert.ok(result.omitted > 0);
  });
});

describe('layout cache and canvas drawing', () => {
  it('recomputes only when an input changes, and never measures on repeated frames', () => {
    const cache = createChatOverlayLayoutCache();
    const comments = some(5);
    const s = settings();
    const input = { comments, settings: s, canvas: LANDSCAPE, bottomInset: 0, fontFamily: FAMILY, measure };
    const first = cache.get(input);
    const callsAfterFirst = measureCalls;
    for (let frame = 0; frame < 120; frame += 1) assert.equal(cache.get({ ...input }), first);
    assert.equal(measureCalls, callsAfterFirst, 'no text measurement while nothing changed');
    assert.notEqual(cache.get({ ...input, comments: [...comments, comment('new', 'fresh')] }), first);
    assert.notEqual(cache.get({ ...input, settings: settings({ size: 'l' }) }), first);
    assert.notEqual(cache.get({ ...input, canvas: PORTRAIT }), first);
    assert.notEqual(cache.get({ ...input, bottomInset: 100 }), first);
  });

  it('reuses wrapped lines for comments that stay on screen when a new one arrives', () => {
    const cache = createChatOverlayLayoutCache();
    const comments = some(5);
    const s = settings();
    const input = { comments, settings: s, canvas: LANDSCAPE, bottomInset: 0, fontFamily: FAMILY, measure };
    cache.get(input);
    const before = measureCalls;
    cache.get({ ...input, comments: [...comments, comment('new', 'fresh')] });
    const added = measureCalls - before;
    measureCalls = 0;
    layoutChatOverlay(input);
    assert.ok(added < measureCalls, `incremental layout (${added}) should measure less than a cold one (${measureCalls})`);
  });

  it('draws the primitives it is given and nothing else', () => {
    const result = run([comment('a', 'Hello there', { question: true })]);
    const calls: string[] = [];
    const ctx = {
      fillStyle: '', font: '', textBaseline: 'alphabetic', textAlign: 'left',
      save: () => calls.push('save'), restore: () => calls.push('restore'), beginPath: () => {}, fill: () => calls.push('fill'),
      rect: () => {}, roundRect: () => calls.push('roundRect'),
      fillText: (text: string) => calls.push(`text:${text}`),
    };
    drawChatOverlay(ctx as never, result, FAMILY);
    assert.equal(calls.filter((c) => c === 'roundRect').length, result.primitives.filter((p) => p.kind === 'rect').length);
    assert.deepEqual(calls.filter((c) => c.startsWith('text:')), result.primitives.filter((p) => p.kind === 'text').map((p) => `text:${(p as { text: string }).text}`));
    assert.equal(calls[0], 'save');
    assert.equal(calls.at(-1), 'restore');
  });
});
