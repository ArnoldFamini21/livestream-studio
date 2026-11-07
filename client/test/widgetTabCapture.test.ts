import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cropTrackToElement,
  drawWidgetCaptureFrame,
  getWidgetTabCaptureOptions,
  getWidgetTabCaptureSupport,
  isTabCaptureTrack,
  planWidgetCaptureCrops,
  WIDGET_STUDIO_ONLY_LABEL,
} from '../src/utils/widgetTabCapture.ts';
import { getWidgetCanvasRect } from '../src/hooks/useCompositor.ts';

const chromium = {
  isSecureContext: true,
  navigator: { mediaDevices: { getDisplayMedia: () => undefined } },
  CropTarget: { fromElement: () => undefined },
  BrowserCaptureMediaStreamTrack: { prototype: { cropTo: () => undefined } },
};

describe('widget tab capture support', () => {
  it('needs getDisplayMedia and Region Capture on a secure page', () => {
    assert.deepEqual(getWidgetTabCaptureSupport(chromium), { supported: true, reason: null });
    assert.equal(getWidgetTabCaptureSupport({ ...chromium, isSecureContext: false }).supported, false);
    assert.equal(getWidgetTabCaptureSupport({ ...chromium, navigator: {} }).supported, false);
    const safari = getWidgetTabCaptureSupport({ ...chromium, CropTarget: undefined });
    assert.equal(safari.supported, false);
    assert.match(safari.reason || '', /Chrome or Edge/);
    assert.match(WIDGET_STUDIO_ONLY_LABEL, /Studio only/);
  });

  it('offers this tab first, without audio or other surfaces', () => {
    const options = getWidgetTabCaptureOptions();
    assert.equal(options.preferCurrentTab, true);
    assert.equal(options.audio, false);
    assert.equal(options.monitorTypeSurfaces, 'exclude');
    assert.equal(options.surfaceSwitching, 'exclude');
  });

  it('only accepts browser-tab captures', () => {
    assert.ok(isTabCaptureTrack({ getSettings: () => ({ displaySurface: 'browser' }) as MediaTrackSettings }));
    assert.ok(!isTabCaptureTrack({ getSettings: () => ({ displaySurface: 'monitor' }) as MediaTrackSettings }));
    assert.ok(!isTabCaptureTrack({ getSettings: () => ({ displaySurface: 'window' }) as MediaTrackSettings }));
  });
});

describe('widget crop planning', () => {
  it('starts crops for new elements and re-crops replaced ones', () => {
    const a = {} as Element;
    const b = {} as Element;
    const b2 = {} as Element;
    const plan = planWidgetCaptureCrops(new Map([['w-a', a], ['w-b', b]]), new Map([['w-b', b2], ['w-c', a]]));
    assert.deepEqual(plan.stop.sort(), ['w-a', 'w-b']);
    assert.deepEqual(plan.start.sort(), ['w-b', 'w-c']);
    assert.deepEqual(planWidgetCaptureCrops(new Map([['w-a', a]]), new Map([['w-a', a]])), { start: [], stop: [] });
  });

  it('crops a capture clone to the widget element', async () => {
    const element = {} as Element;
    const calls: unknown[] = [];
    const track = { cropTo: async (target: unknown) => { calls.push(target); } } as unknown as MediaStreamTrack;
    await cropTrackToElement(track, element, { fromElement: async (el) => ({ el }) });
    assert.deepEqual(calls, [{ el: element }]);
  });
});

describe('drawing captured widgets', () => {
  function fakeContext() {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
    return {
      calls,
      ctx: {
        save: record('save'),
        restore: record('restore'),
        beginPath: record('beginPath'),
        roundRect: record('roundRect'),
        clip: record('clip'),
        drawImage: record('drawImage'),
      } as unknown as CanvasRenderingContext2D,
    };
  }

  it('waits for a frame before drawing', () => {
    const { ctx, calls } = fakeContext();
    const video = { readyState: 1, videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    assert.equal(drawWidgetCaptureFrame(ctx, video, { x: 0, y: 0, width: 100, height: 100 }), false);
    assert.equal(calls.length, 0);
  });

  it('cover-fits the captured frame into the widget box with rounded corners', () => {
    const { ctx, calls } = fakeContext();
    const video = { readyState: 4, videoWidth: 800, videoHeight: 400 } as HTMLVideoElement;
    assert.equal(drawWidgetCaptureFrame(ctx, video, { x: 10, y: 20, width: 200, height: 200 }, 12), true);
    const draw = calls.find((call) => call.name === 'drawImage');
    assert.deepEqual(draw?.args.slice(1), [200, 0, 400, 400, 10, 20, 200, 200]);
    assert.ok(calls.some((call) => call.name === 'clip'));
  });

  it('places placeholder widgets inside the portrait canvas', () => {
    const portrait = { width: 1080, height: 1920 };
    const rect = getWidgetCanvasRect({ widthPercent: 50, heightPercent: 30, position: 'bottom-right' }, portrait);
    assert.equal(rect.width, 540);
    assert.equal(rect.height, 576);
    assert.ok(rect.x + rect.width <= portrait.width && rect.y + rect.height <= portrait.height);
    const centered = getWidgetCanvasRect({ widthPercent: 50, heightPercent: 30, position: 'center' }, portrait);
    assert.equal(centered.x, (1080 - 540) / 2);
  });
});
