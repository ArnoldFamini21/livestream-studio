import { MAX_CUSTOM_LAYOUTS, normalizeCustomLayouts, type CustomLayout } from '@studio/shared';
import { MAX_SCENE_PACK_BYTES, type ScenePack } from './scenePacks.ts';

const DATABASE = 'livestream-studio-service-presets';
const STORE = 'presets';
const MAX_PRESETS = 12;

export interface ServicePresetSnapshot {
  pack: ScenePack;
  layouts: CustomLayout[];
}

export interface ServicePreset extends ServicePresetSnapshot {
  id: string;
  name: string;
  createdAt: string;
}

/** Keep only the portable layouts used by the saved scenes. */
export function captureServicePreset(pack: ScenePack, layouts: CustomLayout[]): ServicePresetSnapshot {
  if (!pack.scenes.length) throw new Error('There are no scenes to save.');
  const usedIds = new Set(pack.scenes.flatMap(scene => scene.layout === 'custom' && scene.customLayoutId ? [scene.customLayoutId] : []));
  const referenced = normalizeCustomLayouts(layouts)
    .filter(layout => usedIds.has(layout.id))
    .map(layout => ({ ...layout, slots: layout.slots.map(slot => ({ ...slot, participantId: undefined })) }));
  if (referenced.length !== usedIds.size) throw new Error('A scene uses a missing custom layout. Update that scene before saving the preset.');
  const snapshot = { pack, layouts: referenced };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SCENE_PACK_BYTES) {
    throw new Error('This preset is too large to save. Try smaller graphics or fewer scenes.');
  }
  return snapshot;
}

/** Reuse matching layouts and give imported layouts fresh IDs without overwriting any saved layout. */
export function prepareServicePreset(
  preset: ServicePresetSnapshot,
  currentLayouts: CustomLayout[],
  sceneSlots: number,
  newId = () => crypto.randomUUID(),
): { pack: ScenePack; layouts: CustomLayout[] } {
  if (sceneSlots <= 0) throw new Error('Make room for a scene before loading this preset.');
  const layouts = [...currentLayouts];
  const imported = normalizeCustomLayouts(preset.layouts);
  const remapped = new Map<string, string>();
  const usedScenes = preset.pack.scenes.slice(0, sceneSlots);
  for (const scene of usedScenes) {
    const id = scene.customLayoutId;
    if (scene.layout !== 'custom' || !id || remapped.has(id)) continue;
    const saved = imported.find(layout => layout.id === id);
    if (!saved) throw new Error('This preset is missing a custom layout.');
    const match = layouts.find(layout => JSON.stringify({ ...layout, id }) === JSON.stringify(saved));
    if (match) {
      remapped.set(id, match.id);
      continue;
    }
    if (layouts.length >= MAX_CUSTOM_LAYOUTS) throw new Error('Make room for a custom layout before loading this preset.');
    const next = { ...saved, id: newId() };
    layouts.push(next);
    remapped.set(id, next.id);
  }
  return {
    pack: {
      ...preset.pack,
      scenes: preset.pack.scenes.map((scene, index) => index >= sceneSlots || !scene.customLayoutId
        ? scene
        : { ...scene, customLayoutId: remapped.get(scene.customLayoutId) ?? null }),
    },
    layouts,
  };
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('This browser cannot save service presets.'));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open service presets.'));
  });
}

export async function listServicePresets(): Promise<ServicePreset[]> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const request: IDBRequest<ServicePreset[]> = db.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      request.onerror = () => reject(request.error ?? new Error('Could not read service presets.'));
    });
  } finally {
    db.close();
  }
}

async function changePresets(action: (store: IDBObjectStore, transaction: IDBTransaction, setError: (error: string) => void) => void) {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      let error = 'Could not update service presets.';
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error(error));
      action(transaction.objectStore(STORE), transaction, message => { error = message; });
    });
  } finally {
    db.close();
  }
}

export async function saveServicePreset(name: string, snapshot: ServicePresetSnapshot): Promise<void> {
  const safeName = name.trim().slice(0, 60);
  if (!safeName) throw new Error('Enter a preset name.');
  const preset: ServicePreset = {
    ...snapshot,
    id: crypto.randomUUID(),
    name: safeName,
    createdAt: new Date().toISOString(),
  };
  await changePresets((store, transaction, setError) => {
    const count = store.count();
    count.onsuccess = () => {
      if (count.result >= MAX_PRESETS) {
        setError('The preset library is full. Remove a preset before saving another.');
        transaction.abort();
        return;
      }
      store.add(preset);
    };
  });
}

export function removeServicePreset(id: string): Promise<void> {
  return changePresets(store => { store.delete(id); });
}
