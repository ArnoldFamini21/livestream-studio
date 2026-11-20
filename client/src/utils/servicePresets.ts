import { MAX_CUSTOM_LAYOUTS, normalizeCustomLayouts, type CustomLayout } from '@studio/shared';
import { MAX_SCENE_PACK_BYTES, validateScenePack, type ScenePack } from './scenePacks.ts';

const DATABASE = 'livestream-studio-service-presets';
const PRESETS = 'presets';
const FOLDERS = 'folders';
const MAX_PRESETS = 12;
const MAX_FOLDERS = MAX_PRESETS;
const PRESET_SOURCE = 'livestream-studio-service-preset';
const PRESET_VERSION = 1;
const MAX_PRESET_NAME_LENGTH = 60;
export const MAX_SERVICE_PRESET_FOLDER_NAME = 40;
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
  folderId?: string;
}

export interface ServicePresetFolder {
  id: string;
  name: string;
}

export interface ServicePresetLibrary {
  presets: ServicePreset[];
  folders: ServicePresetFolder[];
}

export function groupServicePresets({ presets, folders }: ServicePresetLibrary) {
  const groups = folders.map(folder => ({ ...folder, presets: [] as ServicePreset[] }));
  const byId = new Map(groups.map(group => [group.id, group.presets]));
  const unfiled: ServicePreset[] = [];
  for (const preset of presets) {
    (byId.get(preset.folderId ?? '') ?? unfiled).push(preset);
  }
  return { groups, unfiled };
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
    const request = indexedDB.open(DATABASE, 2);
    let blocked = false;
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) request.result.createObjectStore(PRESETS, { keyPath: 'id' });
      request.result.createObjectStore(FOLDERS, { keyPath: 'id' });
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close other Studio tabs and reopen the preset library.'));
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open service presets.'));
  });
}

export async function listServicePresetLibrary(): Promise<ServicePresetLibrary> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction([PRESETS, FOLDERS], 'readonly');
      const presets: IDBRequest<ServicePreset[]> = transaction.objectStore(PRESETS).getAll();
      const folders: IDBRequest<ServicePresetFolder[]> = transaction.objectStore(FOLDERS).getAll();
      transaction.oncomplete = () => resolve({
        presets: presets.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        folders: folders.result.sort((a, b) => a.name.localeCompare(b.name)),
      });
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read service presets.'));
    });
  } finally {
    db.close();
  }
}

async function changeLibrary(action: (presets: IDBObjectStore, folders: IDBObjectStore, abort: (message: string) => void) => void) {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([PRESETS, FOLDERS], 'readwrite');
      let error = 'Could not update presets.';
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error(error));
      action(transaction.objectStore(PRESETS), transaction.objectStore(FOLDERS), message => {
        error = message;
        transaction.abort();
      });
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
  await changeLibrary((store, _folders, abort) => {
    const count = store.count();
    count.onsuccess = () => {
      if (count.result >= MAX_PRESETS) {
        abort('The preset library is full. Remove a preset before saving another.');
        return;
      }
      store.add(preset);
    };
  });
}

export function removeServicePreset(id: string): Promise<void> {
  return changeLibrary(store => { store.delete(id); });
}


export async function saveServicePresetFolder(name: string, id?: string): Promise<void> {
  const safeName = name.trim().slice(0, MAX_SERVICE_PRESET_FOLDER_NAME);
  if (!safeName) throw new Error('Enter a folder name.');
  const nameKey = safeName.toLowerCase();
  if (nameKey === 'unfiled') throw new Error('Choose a folder name other than Unfiled.');
  await changeLibrary((_presets, folders, abort) => {
    const existing: IDBRequest<ServicePresetFolder[]> = folders.getAll();
    existing.onsuccess = () => {
      if (id && !existing.result.some(folder => folder.id === id)) {
        abort('This folder was already removed.');
        return;
      }
      if (existing.result.some(folder => folder.id !== id && folder.name.toLowerCase() === nameKey)) {
        abort('A folder already has that name.');
        return;
      }
      if (!id && existing.result.length >= MAX_FOLDERS) {
        abort('The folder library is full. Remove a folder before adding another.');
        return;
      }
      folders.put({ id: id ?? crypto.randomUUID(), name: safeName } satisfies ServicePresetFolder);
    };
  });
}

export function moveServicePreset(id: string, folderId?: string): Promise<void> {
  return changeLibrary((presets, folders, abort) => {
    const move = () => {
      const current: IDBRequest<ServicePreset | undefined> = presets.get(id);
      current.onsuccess = () => {
        if (!current.result) {
          abort('This preset was already removed.');
          return;
        }
        presets.put({ ...current.result, folderId });
      };
    };
    if (!folderId) {
      move();
      return;
    }
    const target = folders.getKey(folderId);
    target.onsuccess = () => {
      if (target.result === undefined) abort('This folder was already removed.');
      else move();
    };
  });
}

export function removeServicePresetFolder(id: string): Promise<void> {
  return changeLibrary((presets, folders) => {
    const existing: IDBRequest<ServicePreset[]> = presets.getAll();
    existing.onsuccess = () => {
      for (const preset of existing.result) {
        if (preset.folderId === id) presets.put({ ...preset, folderId: undefined });
      }
      folders.delete(id);
    };
  });
}
