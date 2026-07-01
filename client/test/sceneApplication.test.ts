import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCENE_PIP_CORNER,
  getScenePipCornerForApply,
  getSceneStageItemOrderForApply,
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
});
