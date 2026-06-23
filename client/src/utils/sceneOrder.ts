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
