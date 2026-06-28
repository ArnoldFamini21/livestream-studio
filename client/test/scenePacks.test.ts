import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Scene } from '@studio/shared';
import type { BannerData } from '../src/components/BannerOverlay.tsx';
import type { LowerThirdData } from '../src/components/LowerThird.tsx';
import type { TimerData } from '../src/components/TimerOverlay.tsx';
import type { TickerData } from '../src/components/TickerOverlay.tsx';
import {
  buildScenePack,
  buildScenePackFilename,
  importScenePack,
  parseScenePackJson,
} from '../src/utils/scenePacks.ts';

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-main',
    name: 'Main',
    layout: 'pip',
    background: { type: 'color', value: '#111827' },
    brandColor: '#7c3aed',
    logoUrl: null,
    cameraShape: 'rounded',
    nameTagStyle: 'classic',
    logoPlacement: 'top-right',
    logoSize: 'medium',
    logoOpacity: 0.45,
    pipCorner: 'TR',
    focusedVideoItemId: 'local',
    stageItemOrder: ['local', 'guest'],
    visibleOverlayIds: ['lt-1', 'lt-auto', 'banner-1', 'timer-1', 'ticker-1', 'missing-overlay'],
    ...overrides,
  };
}

const lowerThirds: LowerThirdData[] = [
  { id: 'lt-1', name: 'Host', title: 'Producer', style: 'bold', visible: true, durationSeconds: 10, animation: 'bounce', animationDirection: 'right', fontFamily: 'display' },
  { id: 'lt-auto', name: 'Speaker', title: 'Guest', style: 'minimal', visible: true, source: 'auto-speaker' },
  { id: 'lt-unused', name: 'Unused', title: '', style: 'glass', visible: false },
];

const banners: BannerData[] = [
  { id: 'banner-1', text: 'Live now', style: 'breaking', isTicker: false, position: 'bottom', visible: true },
  { id: 'banner-unused', text: 'Unused', style: 'info', isTicker: false, position: 'top', visible: false },
];

const timers: TimerData[] = [
  {
    id: 'timer-1',
    mode: 'countdown',
    durationSeconds: 300,
    remainingSeconds: 120,
    isRunning: true,
    position: 'top-right',
    style: 'bold',
    visible: true,
  },
];

const tickers: TickerData[] = [
  {
    id: 'ticker-1',
    text: 'Breaking updates',
    speed: 'normal',
    backgroundColor: '#111827',
    textColor: '#ffffff',
    visible: true,
    separator: '|',
  },
];

describe('scene packs', () => {
  it('exports scenes with only referenced, portable overlays', () => {
    const pack = buildScenePack({
      scenes: [makeScene()],
      lowerThirds,
      banners,
      timers,
      tickers,
      exportedAt: '2026-06-24T00:00:00.000Z',
    });

    assert.equal(pack.version, 1);
    assert.deepEqual(pack.overlays.lowerThirds.map((item) => item.id), ['lt-1']);
    assert.deepEqual(pack.overlays.banners.map((item) => item.id), ['banner-1']);
    assert.deepEqual(pack.overlays.timers.map((item) => item.id), ['timer-1']);
    assert.deepEqual(pack.overlays.tickers.map((item) => item.id), ['ticker-1']);
    assert.deepEqual(pack.scenes[0].visibleOverlayIds, ['lt-1', 'banner-1', 'timer-1', 'ticker-1']);
    assert.equal(pack.overlays.lowerThirds[0].visible, false);
    assert.equal(pack.overlays.lowerThirds[0].animationDirection, 'right');
    assert.equal(pack.overlays.lowerThirds[0].fontFamily, 'display');
    assert.equal(pack.overlays.timers[0].isRunning, false);
  });

  it('imports scenes by remapping scene and overlay ids while keeping overlays hidden', () => {
    const pack = buildScenePack({
      scenes: [makeScene()],
      lowerThirds,
      banners,
      timers,
      tickers,
    });

    const imported = importScenePack(pack, {
      existingScenes: [makeScene({ id: 'existing-main' })],
      maxScenes: 12,
      sceneIdFactory: (_scene, index) => `scene-imported-${index}`,
      overlayIdFactory: (kind, _oldId, index) => `${kind}-imported-${index}`,
    });

    assert.equal(imported.importedScenes, 1);
    assert.equal(imported.scenes[0].id, 'scene-imported-0');
    assert.equal(imported.scenes[0].name, 'Main Copy');
    assert.equal(imported.scenes[0].logoOpacity, 0.45);
    assert.deepEqual(imported.scenes[0].visibleOverlayIds, [
      'lowerThird-imported-0',
      'banner-imported-0',
      'timer-imported-0',
      'ticker-imported-0',
    ]);
    assert.equal(imported.lowerThirds[0].visible, false);
    assert.equal(imported.lowerThirds[0].animation, 'bounce');
    assert.equal(imported.lowerThirds[0].animationDirection, 'right');
    assert.equal(imported.lowerThirds[0].fontFamily, 'display');
    assert.equal(imported.banners[0].visible, false);
    assert.equal(imported.timers[0].visible, false);
    assert.equal(imported.timers[0].isRunning, false);
    assert.equal(imported.tickers[0].visible, false);
  });

  it('respects the remaining scene slots and reports skipped scenes', () => {
    const pack = buildScenePack({
      scenes: [
        makeScene({ id: 'scene-1', name: 'One', visibleOverlayIds: [] }),
        makeScene({ id: 'scene-2', name: 'Two', visibleOverlayIds: [] }),
        makeScene({ id: 'scene-3', name: 'Three', visibleOverlayIds: [] }),
      ],
      lowerThirds: [],
      banners: [],
      timers: [],
      tickers: [],
    });
    const existingScenes = Array.from({ length: 11 }, (_, index) => makeScene({
      id: `existing-${index}`,
      name: `Existing ${index}`,
      visibleOverlayIds: [],
    }));

    const imported = importScenePack(pack, {
      existingScenes,
      maxScenes: 12,
      sceneIdFactory: (_scene, index) => `scene-imported-${index}`,
    });

    assert.equal(imported.importedScenes, 1);
    assert.equal(imported.skippedScenes, 2);
    assert.deepEqual(imported.scenes.map((scene) => scene.name), ['One']);
  });

  it('rejects malformed or incompatible scene packs', () => {
    assert.throws(() => parseScenePackJson('not json'), /not valid JSON/);
    assert.throws(
      () => parseScenePackJson(JSON.stringify({ version: 2, source: 'livestream-studio', scenes: [], overlays: {} })),
      /not compatible/
    );
    assert.throws(
      () => parseScenePackJson(JSON.stringify({ version: 1, source: 'livestream-studio', scenes: [], overlays: { lowerThirds: [], banners: [], timers: [], tickers: [] } })),
      /does not contain any scenes/
    );
  });

  it('normalizes imported logo watermark opacity', () => {
    const parsed = parseScenePackJson(JSON.stringify({
      version: 1,
      source: 'livestream-studio',
      exportedAt: '2026-06-24T00:00:00.000Z',
      scenes: [makeScene({ logoOpacity: 4 })],
      overlays: { lowerThirds: [], banners: [], timers: [], tickers: [] },
    }));

    assert.equal(parsed.scenes[0].logoOpacity, 1);
  });

  it('round trips valid JSON packs and builds readable filenames', () => {
    const pack = buildScenePack({
      scenes: [makeScene()],
      lowerThirds,
      banners,
      timers,
      tickers,
      exportedAt: '2026-06-24T00:00:00.000Z',
    });
    const parsed = parseScenePackJson(JSON.stringify(pack));

    assert.deepEqual(parsed.scenes, pack.scenes);
    assert.equal(parsed.overlays.lowerThirds[0].animationDirection, 'right');
    assert.equal(parsed.overlays.lowerThirds[0].fontFamily, 'display');
    assert.equal(buildScenePackFilename('Arnold Live Show!', new Date('2026-06-24T12:00:00.000Z')), 'scene-pack-arnold-live-show-2026-06-24.json');
  });
});
