import {
  MAX_RUNDOWN_ITEMS,
  MAX_RUNDOWN_NOTES,
  MAX_RUNDOWN_SCENE_NAME,
  MAX_RUNDOWN_TITLE,
  normalizeProductionRundownScene,
  type ProductionRundown,
  type ProductionRundownItem,
} from '@studio/shared';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, limit)
    .replace(/[\uD800-\uDFFF]/gu, '');
}

function normalizeItem(value: unknown): ProductionRundownItem | undefined {
  const input = record(value);
  if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.id)) return undefined;
  const title = safeText(input.title, MAX_RUNDOWN_TITLE).replace(/\s+/g, ' ');
  if (!title) return undefined;
  const sceneName = safeText(input.sceneName, MAX_RUNDOWN_SCENE_NAME);
  const scene = sceneName && normalizeProductionRundownScene(input.scene);
  return {
    id: input.id,
    title,
    notes: safeText(input.notes, MAX_RUNDOWN_NOTES),
    sceneName,
    ...(scene ? { scene } : {}),
  };
}

export function normalizeProductionRundown(value: unknown): ProductionRundown | undefined {
  const input = record(value);
  if (!input || typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.items)) return undefined;
  const items: ProductionRundownItem[] = [];
  for (const value of input.items.slice(0, MAX_RUNDOWN_ITEMS)) {
    const item = normalizeItem(value);
    if (item && !items.some(existing => existing.id === item.id)) items.push(item);
  }
  return {
    revision: input.revision,
    items,
    cueItemId: items.find(item => item.id === input.cueItemId)?.id ?? null,
    lastTakenItemId: items.find(item => item.id === input.lastTakenItemId)?.id ?? null,
  };
}

export function changeProductionRundown(
  current: ProductionRundown,
  value: unknown,
  canTake: boolean,
): { rundown: ProductionRundown } | { error: string } {
  const command = record(value);
  if (!command) return { error: 'Invalid rundown update.' };
  if (command.baseRevision !== current.revision) return { error: 'The rundown changed. Review the latest version and try again.' };

  const items = [...current.items];
  const next = { ...current, items, revision: current.revision + 1 };
  if (command.action === 'save-item') {
    const item = normalizeItem(command.item);
    if (!item) return { error: 'Enter a title for the rundown item.' };
    const index = items.findIndex(existing => existing.id === item.id);
    if (index >= 0) items[index] = item;
    else if (items.length >= MAX_RUNDOWN_ITEMS) return { error: 'This rundown is full.' };
    else items.push(item);
    return { rundown: next };
  }

  if (command.action === 'cue-item' && command.itemId === null) return { rundown: { ...next, cueItemId: null } };
  const index = items.findIndex(item => item.id === command.itemId);
  if (index === -1) return { error: 'That rundown item is unavailable.' };
  const item = items[index];
  switch (command.action) {
    case 'cue-item':
      return { rundown: { ...next, cueItemId: item.id } };
    case 'take-item':
      if (!canTake) return { error: 'Only the stage owner can take the cued scene.' };
      if (current.cueItemId !== item.id || !item.sceneName) return { error: 'Cue an item with a saved scene name first.' };
      return { rundown: { ...next, cueItemId: null, lastTakenItemId: item.id } };
    case 'remove-item':
      items.splice(index, 1);
      return { rundown: {
        ...next,
        cueItemId: next.cueItemId === item.id ? null : next.cueItemId,
        lastTakenItemId: next.lastTakenItemId === item.id ? null : next.lastTakenItemId,
      } };
    case 'move-item': {
      const target = command.direction === 'up' ? index - 1 : command.direction === 'down' ? index + 1 : -1;
      if (target < 0 || target >= items.length) return { error: 'This item cannot move in that direction.' };
      [items[index], items[target]] = [items[target], items[index]];
      return { rundown: next };
    }
    default:
      return { error: 'Invalid rundown action.' };
  }
}
