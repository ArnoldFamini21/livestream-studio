import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCENE_PIP_CORNER,
  getSceneActiveMediaForApply,
  getSceneActiveMediaSnapshot,
  getScenePipCornerForApply,
  getSceneStageItemOrderForApply,
  normalizeSceneActiveMediaSnapshot,
} from '../src/utils/sceneApplication.ts';

describe('scene application defaults', () => {
  it('uses saved PiP corners and normalized stage order when applying a scene', () => {
    const scene = {
      pipCorner: 'TL',
      stageItemOrder: ['missing', 'guest', 'guest', 'host'],
    };

    assert.equal(getScenePipCornerForApply(scene), 'TL');
    assert.deepEqual(getSceneStageItemOrderForApply(scene, ['host', 'guest', 'screen']), ['guest', 'host', 'screen']);
  });

  it('resets missing or invalid legacy scene values instead of leaking previous scene state', () => {
    assert.equal(getScenePipCornerForApply({}), DEFAULT_SCENE_PIP_CORNER);
    assert.equal(getScenePipCornerForApply({ pipCorner: 'CENTER' as never }), DEFAULT_SCENE_PIP_CORNER);
    assert.deepEqual(getSceneStageItemOrderForApply({}, ['host', 'guest']), []);
    assert.deepEqual(getSceneStageItemOrderForApply({ stageItemOrder: 'host,guest' as never }, ['host', 'guest']), []);
  });

  it('saves a bounded active media snapshot from the live scene state', () => {
    const snapshot = getSceneActiveMediaSnapshot({
      assetId: 'deck-1',
      type: 'presentation',
      url: 'blob:deck',
      name: 'Deck',
      preview: {
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'One', lines: [] },
          { id: 'slide-2', title: 'Two', lines: [] },
        ],
      },
    }, 99);

    assert.deepEqual(snapshot, { assetId: 'deck-1', slideIndex: 1 });
    assert.equal(getSceneActiveMediaSnapshot(null, 0), null);
  });

  it('normalizes imported active media scene snapshots defensively', () => {
    assert.deepEqual(
      normalizeSceneActiveMediaSnapshot({ assetId: ' media-1 ', slideIndex: 2.8 }),
      { assetId: 'media-1', slideIndex: 2 }
    );
    assert.equal(normalizeSceneActiveMediaSnapshot({ assetId: '' }), null);
    assert.equal(normalizeSceneActiveMediaSnapshot('media-1'), null);
  });

  it('resolves saved scene media against the current library and clears missing assets', () => {
    const mediaAssets = [
      {
        id: 'pdf-1',
        name: 'Guide.pdf',
        url: 'blob:pdf',
        type: 'pdf' as const,
        mimeType: 'application/pdf',
        createdAt: '2026-07-02T00:00:00.000Z',
        source: 'upload' as const,
        preview: {
          kind: 'presentation-slides' as const,
          sourceFormat: 'pdf' as const,
          slides: [
            { id: 'page-1', title: 'Page 1', lines: [] },
            { id: 'page-2', title: 'Page 2', lines: [] },
          ],
        },
      },
    ];

    const resolved = getSceneActiveMediaForApply({ activeMedia: { assetId: 'pdf-1', slideIndex: 9 } }, mediaAssets);

    assert.equal(resolved.activeMedia?.assetId, 'pdf-1');
    assert.equal(resolved.activeMedia?.type, 'pdf');
    assert.equal(resolved.slideIndex, 1);
    assert.deepEqual(getSceneActiveMediaForApply({ activeMedia: { assetId: 'missing' } }, mediaAssets), {
      activeMedia: null,
      slideIndex: 0,
    });
  });
});
