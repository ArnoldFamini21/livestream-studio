import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CompositorLayoutCache,
  hasLayoutAnimation,
  isLayoutRelevantMutation,
} from '../src/utils/compositorLayoutCache.ts';
import { loadCanvasFonts } from '../src/utils/canvasFonts.ts';

function element(options: { tag?: string; hasVideo?: boolean; inTile?: boolean }) {
  return {
    nodeType: 1,
    tagName: options.tag ?? 'DIV',
    querySelector: (selector: string) => (selector === 'video' && options.hasVideo ? {} : null),
    closest: () => (options.inTile ? {} : null),
  } as unknown as Element;
}

describe('compositor layout cache', () => {
  it('reuses the plan until the layout changes, then rebuilds while it settles', () => {
    const cache = new CompositorLayoutCache<number>({ settleMs: 100, maxAgeMs: 1_000 });
    let builds = 0;
    const build = () => ++builds;
    assert.equal(cache.get(0, build), 1);
    assert.equal(cache.get(33, build), 1);
    assert.equal(cache.get(66, build), 1, 'no DOM reads while nothing changed');
    cache.invalidate(70);
    assert.equal(cache.get(100, build), 2);
    assert.equal(cache.get(133, build), 3, 'still settling: CSS transitions run after a change');
    assert.equal(cache.get(200, build), 3);
    assert.equal(cache.get(1_200, build), 4, 'and at least once a second regardless');
  });

  it('rebuilds on every frame while a tile animates', () => {
    const cache = new CompositorLayoutCache<number>({ maxAgeMs: 10_000 });
    let builds = 0;
    cache.get(0, () => ++builds);
    cache.get(33, () => ++builds, () => true);
    cache.get(66, () => ++builds, () => true);
    assert.equal(builds, 3);
  });

  it('ignores decoration inside a tile but not tile or stage changes', () => {
    assert.equal(isLayoutRelevantMutation({ type: 'childList', target: element({}) }), true);
    assert.equal(isLayoutRelevantMutation({ type: 'attributes', target: element({ inTile: true }) }), false, 'an audio ring');
    assert.equal(isLayoutRelevantMutation({ type: 'attributes', target: element({ inTile: true, hasVideo: true }) }), true, 'the tile itself');
    assert.equal(isLayoutRelevantMutation({ type: 'attributes', target: element({ tag: 'VIDEO', inTile: true }) }), true);
    assert.equal(isLayoutRelevantMutation({ type: 'attributes', target: element({}) }), true, 'the stage grid');
  });

  it('counts only running animations on elements that hold a video', () => {
    const tile = element({ hasVideo: true });
    const marquee = element({});
    assert.equal(hasLayoutAnimation([{ playState: 'running', effect: { target: tile } }]), true);
    assert.equal(hasLayoutAnimation([{ playState: 'finished', effect: { target: tile } }]), false);
    assert.equal(hasLayoutAnimation([{ playState: 'running', effect: { target: marquee } }]), false, 'a ticker marquee');
    assert.equal(hasLayoutAnimation([{ playState: 'running', effect: null }]), false);
  });
});

describe('canvas fonts', () => {
  it('waits for every face the compositor draws with', async () => {
    const requested: string[] = [];
    const result = await loadCanvasFonts(['700 16px Inter', '900 16px Inter'], {
      load: async (font: string) => { requested.push(font); return []; },
    });
    assert.equal(result, 'loaded');
    assert.deepEqual(requested, ['700 16px Inter', '900 16px Inter']);
  });

  it('never holds the program back on a missing or slow font', async () => {
    assert.equal(await loadCanvasFonts(['700 16px Inter'], { load: () => Promise.reject(new Error('404')) }), 'loaded');
    assert.equal(await loadCanvasFonts(['700 16px Inter'], { load: () => new Promise(() => undefined) }, 20), 'timeout');
    assert.equal(await loadCanvasFonts(['700 16px Inter'], null), 'unavailable');
  });
});
