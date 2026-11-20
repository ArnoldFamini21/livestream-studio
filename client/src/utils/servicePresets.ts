import { MAX_CUSTOM_LAYOUTS, normalizeCustomLayouts, type CustomLayout } from '@studio/shared';
import { MAX_SCENE_PACK_BYTES, validateScenePack, type ScenePack } from './scenePacks.ts';

const DATABASE = 'livestream-studio-service-presets';
const STORE = 'presets';
const MAX_PRESETS = 12;
const PRESET_SOURCE = 'livestream-studio-service-preset';
const PRESET_VERSION = 1;
const MAX_PRESET_NAME_LENGTH = 60;
const MAX_PRESET_FILE_BYTES = MAX_SCENE_PACK_BYTES + 512;
const encoder = new TextEncoder();

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
export function captureServicePreset(pack: ScenePack, layouts: unknown): ServicePresetSnapshot {
  if (!pack.scenes.length) throw new Error('There are no scenes to save.');
  const usedIds = new Set(pack.scenes.flatMap(scene => scene.layout === 'custom' && scene.customLayoutId ? [scene.customLayoutId] : []));
  const referenced = normalizeCustomLayouts(layouts)
    .filter(layout => usedIds.has(layout.id))
    .map(layout => ({ ...layout, slots: layout.slots.map(slot => ({ ...slot, participantId: undefined })) }));
  if (referenced.length !== usedIds.size) throw new Error('A scene uses a missing custom layout. Update that scene before saving the preset.');
  const snapshot = { pack, layouts: referenced };
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SCENE_PACK_BYTES) {
    throw new Error('This preset is too large to save. Try smaller graphics or fewer scenes.');
  }
  return snapshot;
}

export function createServicePresetDownload({ name, pack, layouts }: ServicePreset) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    fileName: slug ? slug + '.service-preset.json' : 'service-preset.json',
    contents: JSON.stringify({ source: PRESET_SOURCE, version: PRESET_VERSION, name, pack, layouts }),
  };
}

export function parseServicePresetFile(contents: string): { name: string; snapshot: ServicePresetSnapshot } {
  if (encoder.encode(contents).byteLength > MAX_PRESET_FILE_BYTES) throw new Error('This service preset file is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('The service preset file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Choose a service preset file downloaded from Studio.');
  }
  const { source, version, name, pack, layouts } = parsed as Record<string, unknown>;
  if (source !== PRESET_SOURCE || version !== PRESET_VERSION || typeof name !== 'string' || !name.trim() || !Array.isArray(layouts)) {
    throw new Error('Choose a service preset file downloaded from Studio.');
  }
  return {
    name: name.trim().slice(0, MAX_PRESET_NAME_LENGTH),
    snapshot: captureServicePreset(validateScenePack(pack), layouts),
  };
}

export async function importServicePreset(file: File): Promise<void> {
  if (file.size > MAX_PRESET_FILE_BYTES) throw new Error('This service preset file is too large.');
  const { name, snapshot } = parseServicePresetFile(await file.text());
  await saveServicePreset(name, snapshot);
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
  const safeName = name.trim().slice(0, MAX_PRESET_NAME_LENGTH);
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
