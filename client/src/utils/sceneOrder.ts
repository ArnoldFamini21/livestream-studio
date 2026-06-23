export type SceneOrderDirection = 'earlier' | 'later';

export function moveSceneInOrder<T extends { id: string }>(
  scenes: T[],
  sceneId: string,
  direction: SceneOrderDirection
): T[] {
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) return scenes;

  const nextIndex = direction === 'earlier' ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= scenes.length) return scenes;

  const next = [...scenes];
  const currentScene = next[index];
  next[index] = next[nextIndex];
  next[nextIndex] = currentScene;
  return next;
}

export function buildDuplicatedSceneName(
  sourceName: string,
  existingNames: string[],
  maxLength = 32
): string {
  const usedNames = new Set(existingNames);

  for (let copyNumber = 1; copyNumber < 100; copyNumber += 1) {
    const suffix = copyNumber === 1 ? ' Copy' : ` Copy ${copyNumber}`;
    const baseLength = Math.max(1, maxLength - suffix.length);
    const baseName = sourceName.slice(0, baseLength).trimEnd() || 'Scene';
    const candidate = `${baseName}${suffix}`;
    if (!usedNames.has(candidate)) return candidate;
  }

  return `Scene Copy ${Date.now().toString(36)}`.slice(0, maxLength);
}

export function duplicateSceneInOrder<T extends { id: string; name: string }>(
  scenes: T[],
  sceneId: string,
  duplicateId: string
): T[] {
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0 || scenes.some((scene) => scene.id === duplicateId)) return scenes;

  const sourceScene = scenes[index];
  const duplicateScene: T = {
    ...sourceScene,
    id: duplicateId,
    name: buildDuplicatedSceneName(sourceScene.name, scenes.map((scene) => scene.name)),
  };

  const next = [...scenes];
  next.splice(index + 1, 0, duplicateScene);
  return next;
}
