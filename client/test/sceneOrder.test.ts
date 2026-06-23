import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDuplicatedSceneName,
  duplicateSceneInOrder,
  moveSceneInOrder,
} from '../src/utils/sceneOrder.ts';

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

  it('duplicates a scene directly after the source with a new id and copy name', () => {
    const duplicated = duplicateSceneInOrder(scenes, 'qa', 'qa-copy');

    assert.deepEqual(duplicated.map((scene) => scene.id), ['starting', 'qa', 'qa-copy', 'brb']);
    assert.equal(duplicated[1], scenes[1]);
    assert.notEqual(duplicated[2], scenes[1]);
    assert.equal(duplicated[2].name, 'Live Q&A Copy');
  });

  it('increments duplicate copy names and preserves the original array on invalid duplicates', () => {
    const namedScenes = [
      ...scenes,
      { id: 'qa-copy', name: 'Live Q&A Copy' },
      { id: 'qa-copy-2', name: 'Live Q&A Copy 2' },
    ];

    assert.equal(buildDuplicatedSceneName('Live Q&A', namedScenes.map((scene) => scene.name)), 'Live Q&A Copy 3');
    assert.equal(duplicateSceneInOrder(namedScenes, 'missing', 'new-id'), namedScenes);
    assert.equal(duplicateSceneInOrder(namedScenes, 'qa', 'brb'), namedScenes);
  });

  it('keeps generated duplicate names within the scene name limit', () => {
    const copyName = buildDuplicatedSceneName('A very long production scene name', [], 16);

    assert.equal(copyName.length, 16);
    assert.equal(copyName, 'A very long Copy');
  });
});
