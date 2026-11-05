import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cubicBezier, OverlayPresenceTracker, transitionProgress } from '../src/utils/canvasMotion.ts';
import {
  BANNER_BAR_HEIGHT_CSS,
  BANNER_BOTTOM_OFFSET_CSS,
  drawBannerOverlay,
  drawSceneTransitionOverlay,
  drawTickerOverlay,
  getBannerColor,
  getBannerTickerX,
  getBannerTop,
  getLowerThirdCanvasMotion,
  getSceneTransitionCanvasState,
  getTickerScrollOffset,
  getTickerSegment,
  TICKER_SPEED_DURATION_SECONDS,
} from '../src/utils/compositorOverlays.ts';
import { getLowerThirdAnimationStyle } from '../src/utils/lowerThirds.ts';
import { getSceneTransitionOverlayStyle } from '../src/utils/sceneTransitions.ts';

const SCALE = { x: 2, y: 2 }; // a 960x540 stage preview

/** A 2D context that records what was drawn; text is 10 px per character. */
function recordingContext() {
  const calls: Array<{ op: string; args: unknown[]; fillStyle?: unknown; font?: string }> = [];
  const state = { fillStyle: '' as unknown, font: '', globalAlpha: 1 };
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args, fillStyle: state.fillStyle, font: state.font });
  };
  const ctx = new Proxy({
    measureText: (text: string) => ({ width: text.length * 10 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key in state) return state[key as keyof typeof state];
      return record(key);
    },
    set(target, key: string, value) {
      if (key in state) (state as Record<string, unknown>)[key] = value;
      else target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, state };
}

describe('canvas motion', () => {
  it('matches CSS cubic-bezier curves', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    assert.ok(Math.abs(linear(0.3) - 0.3) < 1e-4);
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    // CSS "ease" at 50% time is about 80% of the way.
    assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3);
    assert.equal(transitionProgress(-10, 100, linear), 0);
    assert.equal(transitionProgress(500, 100, linear), 1);
  });

  it('keeps a hidden overlay through its exit, then drops it', () => {
    const tracker = new OverlayPresenceTracker<string>(400);
    assert.deepEqual(tracker.update([{ id: 'a', data: 'A' }], 0).map((item) => [item.id, item.phase, item.since]), [['a', 'entering', 0]]);
    assert.deepEqual(tracker.update([{ id: 'a', data: 'A2' }], 100).map((item) => [item.data, item.since]), [['A2', 0]]);
    const exiting = tracker.update([], 1000);
    assert.deepEqual(exiting.map((item) => [item.id, item.phase, item.since]), [['a', 'exiting', 1000]]);
    assert.equal(tracker.update([], 1300).length, 1);
    assert.equal(tracker.update([], 1400).length, 0);
  });
});

describe('lower-third motion matches the preview transitions', () => {
  it('slides in from the chosen direction and settles', () => {
    const lowerThird = { animation: 'slide' as const, animationDirection: 'right' as const };
    const start = getLowerThirdCanvasMotion(lowerThird, 'entering', 0, SCALE);
    assert.deepEqual(start, { alpha: 0, offsetX: 48, offsetY: 32, scale: 1 });
    const hidden = getLowerThirdAnimationStyle('slide', false, 'right');
    assert.equal(hidden.transform, 'translate3d(24px, 16px, 0)', 'same CSS offset, scaled to the output');
    const shown = getLowerThirdCanvasMotion(lowerThird, 'entering', 400, SCALE);
    assert.deepEqual(shown, { alpha: 1, offsetX: 0, offsetY: 0, scale: 1 });
    const middle = getLowerThirdCanvasMotion(lowerThird, 'entering', 150, SCALE);
    assert.ok(middle.alpha > 0.5 && middle.alpha < 1, 'ease-out: most of the way early');
  });

  it('runs the exit in reverse and fades without moving for "fade"', () => {
    const exit = getLowerThirdCanvasMotion({ animation: 'slide', animationDirection: 'up' }, 'exiting', 400, SCALE);
    assert.deepEqual(exit, { alpha: 0, offsetX: 0, offsetY: 48, scale: 1 });
    const fade = getLowerThirdCanvasMotion({ animation: 'fade' }, 'entering', 160, SCALE);
    assert.equal(fade.offsetX, 0);
    assert.equal(fade.offsetY, 0);
    assert.ok(fade.alpha > 0 && fade.alpha < 1);
  });

  it('bounces past full size on the way in', () => {
    const samples = [60, 120, 180, 240, 300].map((ms) => getLowerThirdCanvasMotion({ animation: 'bounce' }, 'entering', ms, SCALE).scale);
    assert.ok(samples.some((scale) => scale > 1), 'overshoot like cubic-bezier(0.34, 1.56, 0.64, 1)');
    assert.equal(getLowerThirdCanvasMotion({ animation: 'bounce' }, 'entering', 0, SCALE).scale, 0.94);
  });
});

describe('ticker scrolling', () => {
  it('scrolls one block of eight segments per preview duration', () => {
    const segmentWidth = 100;
    const durationMs = TICKER_SPEED_DURATION_SECONDS.normal * 1000;
    assert.equal(getTickerScrollOffset(0, 'normal', segmentWidth), 0);
    assert.equal(getTickerScrollOffset(durationMs / 2, 'normal', segmentWidth), 400);
    assert.equal(getTickerScrollOffset(durationMs, 'normal', segmentWidth), 0, 'seamless loop');
    assert.ok(getTickerScrollOffset(1000, 'fast', segmentWidth) > getTickerScrollOffset(1000, 'slow', segmentWidth));
  });

  it('draws the ticker in its own colours across the whole bar', () => {
    const { ctx, calls } = recordingContext();
    drawTickerOverlay(ctx, {
      id: 't', text: 'Hello', speed: 'normal', backgroundColor: '#112233', textColor: '#ffcc00', visible: true, separator: '•',
    }, 0, SCALE);
    const bar = calls.find((call) => call.op === 'fillRect');
    assert.deepEqual(bar?.args, [0, 1080 - 72, 1920, 72]);
    assert.equal(bar?.fillStyle, '#112233');
    const texts = calls.filter((call) => call.op === 'fillText');
    assert.ok(texts.length >= Math.floor(1920 / (getTickerSegment({ text: 'Hello', separator: '•' }).length * 10)));
    assert.ok(texts.every((call) => call.fillStyle === '#ffcc00'));
    assert.equal(texts[0].font, '600 28px Inter, Arial, sans-serif');
  });
});

describe('banners', () => {
  it('sits at the top or above the ticker strip, like the preview', () => {
    assert.equal(getBannerTop('top', SCALE), 0);
    assert.equal(getBannerTop('bottom', SCALE), 1080 - (BANNER_BOTTOM_OFFSET_CSS + BANNER_BAR_HEIGHT_CSS) * 2);
    assert.equal(getBannerColor({ style: 'breaking' }), '#dc2626');
    assert.equal(getBannerColor({ style: 'custom', customColor: '#123456' }), '#123456');
  });

  it('truncates long static text inside the bar', () => {
    const { ctx, calls } = recordingContext();
    drawBannerOverlay(ctx, {
      id: 'b', text: 'x'.repeat(400), style: 'info', isTicker: false, position: 'top', visible: true,
    }, 0, SCALE);
    const text = calls.find((call) => call.op === 'fillText');
    const drawn = String(text?.args[0]);
    assert.ok(drawn.endsWith('...'));
    assert.ok(drawn.length * 10 <= 1920 - 64);
  });

  it('scrolls a ticker banner from the right edge off to the left', () => {
    assert.equal(getBannerTickerX(0, 1920, 400, SCALE), 1920);
    const durationMs = Math.max(8, (1920 + 400) / 2 / 80) * 1000;
    assert.ok(Math.abs(getBannerTickerX(durationMs - 1, 1920, 400, SCALE) + 400) < 1);
  });
});

describe('scene transitions in the program', () => {
  it('reveals the new scene with the preview curve for each preset', () => {
    const start = getSceneTransitionCanvasState('fade', 0, 520);
    assert.equal(start.alpha, 1);
    assert.equal(getSceneTransitionOverlayStyle({ presetId: 'fade', visible: true, durationMs: 520 }).opacity, 1);
    assert.equal(getSceneTransitionCanvasState('fade', 520, 520).done, true);
    assert.ok(getSceneTransitionCanvasState('wipe', 260, 520).clipLeft > 0.5);
    assert.ok(getSceneTransitionCanvasState('slide', 260, 520).translateX > 0.5);
    const zoom = getSceneTransitionCanvasState('zoom', 260, 520);
    assert.ok(zoom.scale > 1 && zoom.alpha < 1);
    assert.equal(getSceneTransitionCanvasState('stinger', 1000, 1200).alpha, 1, 'a stinger stays up for its clip');
  });

  it('draws the stinger clip only when it is safe, otherwise the scene name', () => {
    const transition = { presetId: 'stinger' as const, sceneName: 'Interview', startedAt: 0, durationMs: 1200 };
    const withClip = recordingContext();
    assert.equal(drawSceneTransitionOverlay(withClip.ctx, transition, 100, '#3b82f6', SCALE, () => true), true);
    assert.equal(withClip.calls.some((call) => call.op === 'fillText'), false);
    const tainted = recordingContext();
    drawSceneTransitionOverlay(tainted.ctx, transition, 100, '#3b82f6', SCALE, () => false);
    assert.equal(tainted.calls.find((call) => call.op === 'fillText')?.args[0], 'Interview');
    const finished = recordingContext();
    assert.equal(drawSceneTransitionOverlay(finished.ctx, { ...transition, presetId: 'fade' }, 2000, '#3b82f6', SCALE), false);
    assert.equal(finished.calls.length, 0);
  });
});
