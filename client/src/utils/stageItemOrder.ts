export type StageItemOrderDirection = 'first' | 'left' | 'right';

export interface StageOrderedItem {
  id: string;
}

function arrayEquals(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizeStageItemOrder(order: string[], availableIds: string[]): string[] {
  const available = new Set(availableIds);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of order) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }

  for (const id of availableIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }

  return arrayEquals(order, next) ? order : next;
}

export function applyStageItemOrder<T extends StageOrderedItem>(
  items: T[],
  order: string[],
  focusedItemId: string | null = null
): T[] {
  const normalizedOrder = normalizeStageItemOrder(order, items.map((item) => item.id));
  const orderIndex = new Map(normalizedOrder.map((id, index) => [id, index]));
  const ordered = [...items].sort((left, right) => (
    (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
    (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));

  if (!focusedItemId) return ordered;
  const focusedIndex = ordered.findIndex((item) => item.id === focusedItemId);
  if (focusedIndex <= 0) return ordered;
  const focusedItem = ordered[focusedIndex];
  return [
    focusedItem,
    ...ordered.slice(0, focusedIndex),
    ...ordered.slice(focusedIndex + 1),
  ];
}

export function moveStageItemInOrder(
  order: string[],
  availableIds: string[],
  itemId: string,
  direction: StageItemOrderDirection
): string[] {
  const next = normalizeStageItemOrder(order, availableIds);
  const index = next.indexOf(itemId);
  if (index === -1) return next;

  if (direction === 'first') {
    if (index === 0) return next;
    return [itemId, ...next.slice(0, index), ...next.slice(index + 1)];
  }

  if (direction === 'left') {
    if (index === 0) return next;
    const moved = [...next];
    [moved[index - 1], moved[index]] = [moved[index], moved[index - 1]];
    return moved;
  }

  if (index === next.length - 1) return next;
  const moved = [...next];
  [moved[index], moved[index + 1]] = [moved[index + 1], moved[index]];
  return moved;
}
