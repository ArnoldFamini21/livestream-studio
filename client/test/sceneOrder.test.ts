import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moveSceneInOrder } from '../src/utils/sceneOrder.ts';

const scenes = [
  { id: 'starting', name: 'Starting Soon' },
  { id: 'qa', name: 'Live Q&A' },
  { id: 'brb', name: 'BRB' },
];

describe('scene ordering', () => {
  it('moves scenes earlier and later without changing scene objects', () => {
    const movedEarlier = moveSceneInOrder(scenes, 'brb', 'earlier');
    assert.deepEqual(movedEarlier.map((scene) => scene.id), ['starting', 'brb', 'qa']);
    assert.equal(movedEarlier[1], scenes[2]);

    const movedLater = moveSceneInOrder(scenes, 'starting', 'later');
    assert.deepEqual(movedLater.map((scene) => scene.id), ['qa', 'starting', 'brb']);
    assert.equal(movedLater[1], scenes[0]);
  });

  it('returns the same scene array for missing or out-of-bounds moves', () => {
    assert.equal(moveSceneInOrder(scenes, 'missing', 'earlier'), scenes);
    assert.equal(moveSceneInOrder(scenes, 'starting', 'earlier'), scenes);
    assert.equal(moveSceneInOrder(scenes, 'brb', 'later'), scenes);
  });
});
