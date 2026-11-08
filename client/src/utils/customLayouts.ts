import type { CSSProperties } from 'react';
import {
  MAX_CUSTOM_LAYOUT_NAME_LENGTH,
  MAX_CUSTOM_LAYOUT_SLOTS,
  MAX_CUSTOM_LAYOUTS,
  MIN_CUSTOM_LAYOUT_SLOT_SIZE,
  normalizeCustomLayout,
  normalizeCustomLayouts,
  type BroadcastOrientation,
  type CustomLayout,
  type CustomLayoutSlot,
  type CustomLayoutSlotKind,
  type CustomLayoutSlotShape,
} from '@studio/shared';

/**
 * Custom (StreamYard-style) layouts: boxes placed freely on the program
 * canvas in normalized 0..1 coordinates. The stage renders each slot as an
 * absolutely positioned tile wrapper, and the compositor reads tile rects from
 * the DOM, so the broadcast and the recording follow without their own code.
 */

export { MAX_CUSTOM_LAYOUTS, MAX_CUSTOM_LAYOUT_SLOTS, normalizeCustomLayout, normalizeCustomLayouts };

/** Grid step for dragging and resizing: 2.5% of the canvas. */
export const CUSTOM_LAYOUT_GRID_STEP = 0.025;
/** How close (as a fraction of the canvas) an edge must come to snap to a guide. */
export const CUSTOM_LAYOUT_SNAP_THRESHOLD = 0.012;
/** Arrow keys move by 0.5%, Shift+arrow by one grid step. */
export const CUSTOM_LAYOUT_NUDGE_STEP = 0.005;
/** Rounded slot corners, in stage CSS pixels (the stage is 960 or 540 wide). */
export const CUSTOM_LAYOUT_ROUNDED_RADIUS_PX = 16;

export type CustomLayoutTemplateId = 'side-by-side' | 'picture-in-picture' | 'three-up' | 'content-two-cameras';
export type CustomLayoutResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

export interface CustomLayoutTemplate {
  id: CustomLayoutTemplateId;
  label: string;
  description: string;
}

export const CUSTOM_LAYOUT_TEMPLATES: CustomLayoutTemplate[] = [
  { id: 'side-by-side', label: 'Side by side', description: 'Two equal cameras' },
  { id: 'picture-in-picture', label: 'Picture in picture', description: 'A full camera with a small round one' },
  { id: 'three-up', label: '3-up', description: 'Three equal cameras' },
  { id: 'content-two-cameras', label: 'Content + 2 cameras', description: 'Shared content with two cameras beside it' },
];

type SlotDraft = Omit<CustomLayoutSlot, 'id' | 'z'> & { z?: number };

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Width over height of the canvas a layout is drawn on. */
export function getCustomLayoutCanvasAspect(orientation: BroadcastOrientation): number {
  return orientation === 'portrait' ? 9 / 16 : 16 / 9;
}

/** The normalized height that makes a slot of normalized width `w` square on screen. */
export function getSquareSlotHeight(w: number, orientation: BroadcastOrientation): number {
  return w * getCustomLayoutCanvasAspect(orientation);
}

function templateSlots(templateId: CustomLayoutTemplateId, orientation: BroadcastOrientation): SlotDraft[] {
  const portrait = orientation === 'portrait';
  switch (templateId) {
    case 'side-by-side':
      return portrait
        ? [
            { x: 0.04, y: 0.03, w: 0.92, h: 0.455, shape: 'rounded', kind: 'camera' },
            { x: 0.04, y: 0.515, w: 0.92, h: 0.455, shape: 'rounded', kind: 'camera' },
          ]
        : [
            { x: 0.02, y: 0.1, w: 0.475, h: 0.8, shape: 'rounded', kind: 'camera' },
            { x: 0.505, y: 0.1, w: 0.475, h: 0.8, shape: 'rounded', kind: 'camera' },
          ];
    case 'picture-in-picture': {
      const smallW = portrait ? 0.34 : 0.2;
      const smallH = round(getSquareSlotHeight(smallW, orientation));
      return [
        { x: 0, y: 0, w: 1, h: 1, shape: 'rect', kind: 'camera' },
        { x: round(1 - smallW - 0.04), y: round(1 - smallH - (portrait ? 0.03 : 0.06)), w: smallW, h: smallH, shape: 'circle', kind: 'camera' },
      ];
    }
    case 'three-up':
      return portrait
        ? [0, 1, 2].map((index) => ({ x: 0.04, y: round(0.03 + index * 0.32), w: 0.92, h: 0.3, shape: 'rounded' as const, kind: 'camera' as const }))
        : [0, 1, 2].map((index) => ({ x: round(0.02 + index * 0.325), y: 0.2, w: 0.31, h: 0.6, shape: 'rounded' as const, kind: 'camera' as const }));
    case 'content-two-cameras':
      return portrait
        ? [
            { x: 0.04, y: 0.03, w: 0.92, h: 0.46, shape: 'rounded', kind: 'content' },
            { x: 0.04, y: 0.52, w: 0.45, h: 0.45, shape: 'rounded', kind: 'camera' },
            { x: 0.51, y: 0.52, w: 0.45, h: 0.45, shape: 'rounded', kind: 'camera' },
          ]
        : [
            { x: 0.02, y: 0.05, w: 0.7, h: 0.9, shape: 'rounded', kind: 'content' },
            { x: 0.74, y: 0.05, w: 0.24, h: 0.435, shape: 'rounded', kind: 'camera' },
            { x: 0.74, y: 0.515, w: 0.24, h: 0.435, shape: 'rounded', kind: 'camera' },
          ];
  }
}

export function createCustomLayoutId(prefix = 'layout'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getCustomLayoutTemplate(templateId: CustomLayoutTemplateId): CustomLayoutTemplate {
  return CUSTOM_LAYOUT_TEMPLATES.find((template) => template.id === templateId) || CUSTOM_LAYOUT_TEMPLATES[0];
}

export function buildCustomLayoutName(base: string, existingNames: string[]): string {
  const trimmed = base.trim().slice(0, MAX_CUSTOM_LAYOUT_NAME_LENGTH) || 'Custom layout';
  if (!existingNames.includes(trimmed)) return trimmed;
  for (let copy = 2; copy < 100; copy += 1) {
    const suffix = ` ${copy}`;
    const candidate = `${trimmed.slice(0, MAX_CUSTOM_LAYOUT_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!existingNames.includes(candidate)) return candidate;
  }
  return trimmed;
}

export function createCustomLayoutFromTemplate(
  templateId: CustomLayoutTemplateId,
  orientation: BroadcastOrientation,
  existingNames: string[] = [],
  id = createCustomLayoutId()
): CustomLayout {
  const template = getCustomLayoutTemplate(templateId);
  const layout = normalizeCustomLayout({
    id,
    name: buildCustomLayoutName(template.label, existingNames),
    orientation,
    slots: templateSlots(template.id, orientation).map((slot, index) => ({ ...slot, id: `slot-${index + 1}`, z: slot.z ?? index })),
  });
  if (!layout) throw new Error('Invalid custom layout template.');
  return layout;
}

/** A copy with a new id and name, for "Duplicate layout". */
export function duplicateCustomLayout(layout: CustomLayout, existingNames: string[], id = createCustomLayoutId()): CustomLayout {
  return {
    ...layout,
    id,
    name: buildCustomLayoutName(`${layout.name} copy`, existingNames),
    slots: layout.slots.map((slot) => ({ ...slot })),
  };
}

function nextSlotId(layout: CustomLayout): string {
  const ids = new Set(layout.slots.map((slot) => slot.id));
  for (let index = layout.slots.length + 1; ; index += 1) {
    const id = `slot-${index}`;
    if (!ids.has(id)) return id;
  }
}

function topZ(layout: CustomLayout): number {
  return layout.slots.reduce((max, slot) => Math.max(max, slot.z), -1);
}

/** Adds a slot in the middle, above the others; null when the layout is full or already has content. */
export function addCustomLayoutSlot(layout: CustomLayout, kind: CustomLayoutSlotKind): { layout: CustomLayout; slotId: string } | null {
  if (layout.slots.length >= MAX_CUSTOM_LAYOUT_SLOTS) return null;
  if (kind === 'content' && layout.slots.some((slot) => slot.kind === 'content')) return null;
  const portrait = layout.orientation === 'portrait';
  // Landscape cameras start 16:9; portrait ones about square.
  const w = kind === 'content' ? (portrait ? 0.9 : 0.5) : portrait ? 0.44 : 0.25;
  const h = kind === 'content' ? (portrait ? 0.3 : 0.5) : 0.25;
  const slotId = nextSlotId(layout);
  const slot: CustomLayoutSlot = {
    id: slotId,
    x: round((1 - w) / 2),
    y: round((1 - h) / 2),
    w,
    h,
    z: Math.min(99, topZ(layout) + 1),
    shape: 'rounded',
    kind,
  };
  return { layout: { ...layout, slots: [...layout.slots, slot] }, slotId };
}

export function duplicateCustomLayoutSlot(layout: CustomLayout, slotId: string): { layout: CustomLayout; slotId: string } | null {
  const source = layout.slots.find((slot) => slot.id === slotId);
  if (!source || layout.slots.length >= MAX_CUSTOM_LAYOUT_SLOTS) return null;
  if (source.kind === 'content') return null;
  const id = nextSlotId(layout);
  const offset = CUSTOM_LAYOUT_GRID_STEP;
  const copy: CustomLayoutSlot = {
    ...source,
    id,
    x: round(clamp(source.x + offset, 0, 1 - source.w)),
    y: round(clamp(source.y + offset, 0, 1 - source.h)),
    z: Math.min(99, topZ(layout) + 1),
  };
  delete copy.participantId;
  return { layout: { ...layout, slots: [...layout.slots, copy] }, slotId: id };
}

/** Removes a slot; the last slot stays (a layout needs at least one). */
export function removeCustomLayoutSlot(layout: CustomLayout, slotId: string): CustomLayout {
  if (layout.slots.length <= 1) return layout;
  return { ...layout, slots: layout.slots.filter((slot) => slot.id !== slotId) };
}

export function updateCustomLayoutSlot(layout: CustomLayout, slotId: string, update: Partial<Omit<CustomLayoutSlot, 'id'>>): CustomLayout {
  return {
    ...layout,
    slots: layout.slots.map((slot) => {
      if (slot.id !== slotId) return slot;
      const next: CustomLayoutSlot = { ...slot, ...update };
      if (next.kind === 'content') delete next.participantId;
      if (update.participantId === null || update.participantId === '') delete next.participantId;
      if (update.shape === 'circle' && slot.shape !== 'circle') {
        // A circle needs a square box on screen.
        const side = Math.min(next.w, next.h / getCustomLayoutCanvasAspect(layout.orientation));
        next.w = round(side);
        next.h = round(getSquareSlotHeight(side, layout.orientation));
      }
      return clampSlot(next);
    }),
  };
}

/** Moves a slot to the top or bottom of the stack. */
export function restackCustomLayoutSlot(layout: CustomLayout, slotId: string, direction: 'front' | 'back'): CustomLayout {
  const ordered = [...layout.slots].sort((a, b) => a.z - b.z).filter((slot) => slot.id !== slotId);
  const target = layout.slots.find((slot) => slot.id === slotId);
  if (!target) return layout;
  const stack = direction === 'front' ? [...ordered, target] : [target, ...ordered];
  const zById = new Map(stack.map((slot, index) => [slot.id, index]));
  return { ...layout, slots: layout.slots.map((slot) => ({ ...slot, z: zById.get(slot.id) ?? slot.z })) };
}

function clampSlot(slot: CustomLayoutSlot): CustomLayoutSlot {
  const w = clamp(slot.w, MIN_CUSTOM_LAYOUT_SLOT_SIZE, 1);
  const h = clamp(slot.h, MIN_CUSTOM_LAYOUT_SLOT_SIZE, 1);
  return {
    ...slot,
    w: round(w),
    h: round(h),
    x: round(clamp(slot.x, 0, 1 - w)),
    y: round(clamp(slot.y, 0, 1 - h)),
  };
}

export interface CustomLayoutSnapOptions {
  /** Snap to the grid step (default on). Hold Alt in the editor to place freely. */
  grid?: boolean;
  /** Snap to the canvas edges/centre and to the edges of the other slots (default on). */
  guides?: boolean;
  gridStep?: number;
  threshold?: number;
}

interface AxisGuides {
  x: number[];
  y: number[];
}

/** Canvas edges and centre, plus every edge and centre line of the other slots. */
export function getCustomLayoutGuides(slots: CustomLayoutSlot[], excludeId: string | null): AxisGuides {
  const x = [0, 0.5, 1];
  const y = [0, 0.5, 1];
  for (const slot of slots) {
    if (slot.id === excludeId) continue;
    x.push(slot.x, slot.x + slot.w / 2, slot.x + slot.w);
    y.push(slot.y, slot.y + slot.h / 2, slot.y + slot.h);
  }
  return { x, y };
}

function nearestGuide(value: number, guides: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDistance = threshold;
  for (const guide of guides) {
    const distance = Math.abs(guide - value);
    if (distance <= bestDistance) {
      best = guide;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Snaps one edge position: a guide within the threshold wins, otherwise the
 * grid. Returns the snapped value and the guide it locked to (for drawing).
 */
export function snapCustomLayoutValue(value: number, guides: number[], options: CustomLayoutSnapOptions = {}): { value: number; guide: number | null } {
  const threshold = options.threshold ?? CUSTOM_LAYOUT_SNAP_THRESHOLD;
  if (options.guides !== false) {
    const guide = nearestGuide(value, guides, threshold);
    if (guide !== null) return { value: guide, guide };
  }
  if (options.grid !== false) {
    const step = options.gridStep ?? CUSTOM_LAYOUT_GRID_STEP;
    return { value: Math.round(value / step) * step, guide: null };
  }
  return { value, guide: null };
}

export interface CustomLayoutSlotEdit {
  slot: CustomLayoutSlot;
  /** Guides the slot locked to, for the editor's alignment lines. */
  guidesX: number[];
  guidesY: number[];
}

/**
 * Drags a slot by (dx, dy) from where it started. The slot keeps its size;
 * whichever of its leading edge, centre or trailing edge lands nearest a
 * guide decides the snap.
 */
export function moveCustomLayoutSlot(
  start: CustomLayoutSlot,
  dx: number,
  dy: number,
  others: CustomLayoutSlot[],
  options: CustomLayoutSnapOptions = {}
): CustomLayoutSlotEdit {
  const guides = getCustomLayoutGuides(others, start.id);
  const rawX = clamp(start.x + dx, 0, 1 - start.w);
  const rawY = clamp(start.y + dy, 0, 1 - start.h);
  const axis = (raw: number, size: number, lines: number[]) => {
    if (options.guides !== false) {
      const threshold = options.threshold ?? CUSTOM_LAYOUT_SNAP_THRESHOLD;
      let best: { value: number; guide: number; distance: number } | null = null;
      for (const offset of [0, size / 2, size]) {
        const guide = nearestGuide(raw + offset, lines, threshold);
        if (guide === null) continue;
        const distance = Math.abs(guide - (raw + offset));
        if (!best || distance < best.distance) best = { value: guide - offset, guide, distance };
      }
      if (best) return { value: best.value, guide: best.guide as number | null };
    }
    return snapCustomLayoutValue(raw, [], { ...options, guides: false });
  };
  const snappedX = axis(rawX, start.w, guides.x);
  const snappedY = axis(rawY, start.h, guides.y);
  return {
    slot: clampSlot({ ...start, x: snappedX.value, y: snappedY.value }),
    guidesX: snappedX.guide === null ? [] : [snappedX.guide],
    guidesY: snappedY.guide === null ? [] : [snappedY.guide],
  };
}

/**
 * Resizes a slot from one of its handles by (dx, dy). Circles stay round on
 * screen (the opposite corner is the anchor).
 */
export function resizeCustomLayoutSlot(
  start: CustomLayoutSlot,
  handle: CustomLayoutResizeHandle,
  dx: number,
  dy: number,
  others: CustomLayoutSlot[],
  orientation: BroadcastOrientation,
  options: CustomLayoutSnapOptions = {}
): CustomLayoutSlotEdit {
  const guides = getCustomLayoutGuides(others, start.id);
  const min = MIN_CUSTOM_LAYOUT_SLOT_SIZE;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  const guidesX: number[] = [];
  const guidesY: number[] = [];

  if (handle.includes('w')) {
    const snapped = snapCustomLayoutValue(clamp(left + dx, 0, right - min), guides.x, options);
    left = clamp(snapped.value, 0, right - min);
    if (snapped.guide !== null) guidesX.push(snapped.guide);
  }
  if (handle.includes('e')) {
    const snapped = snapCustomLayoutValue(clamp(right + dx, left + min, 1), guides.x, options);
    right = clamp(snapped.value, left + min, 1);
    if (snapped.guide !== null) guidesX.push(snapped.guide);
  }
  if (handle.includes('n')) {
    const snapped = snapCustomLayoutValue(clamp(top + dy, 0, bottom - min), guides.y, options);
    top = clamp(snapped.value, 0, bottom - min);
    if (snapped.guide !== null) guidesY.push(snapped.guide);
  }
  if (handle.includes('s')) {
    const snapped = snapCustomLayoutValue(clamp(bottom + dy, top + min, 1), guides.y, options);
    bottom = clamp(snapped.value, top + min, 1);
    if (snapped.guide !== null) guidesY.push(snapped.guide);
  }

  let next: CustomLayoutSlot = { ...start, x: left, y: top, w: right - left, h: bottom - top };
  if (start.shape === 'circle') {
    const aspect = getCustomLayoutCanvasAspect(orientation);
    // The side follows whichever edge moved; horizontal-only handles drive the width.
    const verticalOnly = handle === 'n' || handle === 's';
    let side = verticalOnly ? next.h / aspect : next.w;
    const anchorRight = handle.includes('w');
    const anchorBottom = handle.includes('n');
    const maxW = anchorRight ? start.x + start.w : 1 - start.x;
    const maxH = anchorBottom ? start.y + start.h : 1 - start.y;
    side = clamp(side, min, Math.min(maxW, maxH / aspect));
    const h = side * aspect;
    next = {
      ...next,
      w: side,
      h,
      x: anchorRight ? start.x + start.w - side : start.x,
      y: anchorBottom ? start.y + start.h - h : start.y,
    };
    guidesX.length = 0;
    guidesY.length = 0;
  }
  return { slot: clampSlot(next), guidesX, guidesY };
}

/** Arrow-key nudging (Shift for a grid step). Returns null for other keys. */
export function nudgeCustomLayoutSlot(slot: CustomLayoutSlot, key: string, large: boolean): CustomLayoutSlot | null {
  const step = large ? CUSTOM_LAYOUT_GRID_STEP : CUSTOM_LAYOUT_NUDGE_STEP;
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const move = delta[key];
  if (!move) return null;
  return clampSlot({ ...slot, x: slot.x + move[0], y: slot.y + move[1] });
}

/** Saved layouts with this one replaced (or added at the front), bounded. */
export function upsertCustomLayout(layouts: CustomLayout[], layout: CustomLayout): CustomLayout[] {
  const normalized = normalizeCustomLayout(layout);
  if (!normalized) return layouts;
  const index = layouts.findIndex((item) => item.id === normalized.id);
  if (index >= 0) return layouts.map((item, i) => (i === index ? normalized : item));
  return [normalized, ...layouts].slice(0, MAX_CUSTOM_LAYOUTS);
}

// ---------------------------------------------------------------------------
// Stage rendering
// ---------------------------------------------------------------------------

export interface CustomLayoutAssignment {
  slotId: string;
  itemId: string;
}

/**
 * Which stage item fills which camera slot. Pinned slots take their item when
 * it is on stage; the other camera slots fill in slot order with the remaining
 * items in stage order. Items without a slot are left off the stage.
 */
export function assignCustomLayoutSlots(layout: CustomLayout, stageItemIds: string[]): CustomLayoutAssignment[] {
  const onStage = new Set(stageItemIds);
  const used = new Set<string>();
  const assigned = new Map<string, string>();
  const cameraSlots = layout.slots.filter((slot) => slot.kind === 'camera');
  for (const slot of cameraSlots) {
    const pinned = slot.participantId;
    if (pinned && onStage.has(pinned) && !used.has(pinned)) {
      assigned.set(slot.id, pinned);
      used.add(pinned);
    }
  }
  const remaining = stageItemIds.filter((id) => !used.has(id));
  for (const slot of cameraSlots) {
    if (assigned.has(slot.id)) continue;
    const next = remaining.shift();
    if (!next) break;
    assigned.set(slot.id, next);
  }
  // Render in stage order so a tile keeps its element when people move between slots.
  return stageItemIds
    .map((itemId) => {
      for (const [slotId, id] of assigned) if (id === itemId) return { slotId, itemId };
      return null;
    })
    .filter((entry): entry is CustomLayoutAssignment => Boolean(entry));
}

export function getCustomLayoutSlotStyle(slot: CustomLayoutSlot, zBase = 2): CSSProperties {
  return {
    position: 'absolute',
    left: `${round(slot.x * 100)}%`,
    top: `${round(slot.y * 100)}%`,
    width: `${round(slot.w * 100)}%`,
    height: `${round(slot.h * 100)}%`,
    minWidth: 0,
    minHeight: 0,
    flexShrink: 0,
    flexGrow: 0,
    aspectRatio: 'auto',
    zIndex: zBase + slot.z,
    borderRadius: getCustomLayoutSlotRadius(slot.shape),
    overflow: 'hidden',
    boxSizing: 'border-box',
  };
}

export function getCustomLayoutSlotRadius(shape: CustomLayoutSlotShape): CSSProperties['borderRadius'] {
  if (shape === 'circle') return '50%';
  if (shape === 'rounded') return CUSTOM_LAYOUT_ROUNDED_RADIUS_PX;
  return 0;
}

export const CUSTOM_LAYOUT_CONTAINER_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  padding: 0,
  overflow: 'hidden',
  boxSizing: 'border-box',
};

export interface CustomStagePlan {
  /** Stage item ids to render, in render order. */
  itemOrder: string[];
  /** Tile wrapper styles aligned with itemOrder. */
  tileStyles: CSSProperties[];
  containerStyle: CSSProperties;
  /** Where shared content goes, when the layout has a content slot. */
  contentStyle: CSSProperties | null;
}

export function getCustomStagePlan(layout: CustomLayout, stageItemIds: string[]): CustomStagePlan {
  const slotsById = new Map(layout.slots.map((slot) => [slot.id, slot]));
  const assignments = assignCustomLayoutSlots(layout, stageItemIds);
  const content = layout.slots.find((slot) => slot.kind === 'content') || null;
  return {
    itemOrder: assignments.map((entry) => entry.itemId),
    tileStyles: assignments.map((entry) => getCustomLayoutSlotStyle(slotsById.get(entry.slotId) as CustomLayoutSlot)),
    containerStyle: CUSTOM_LAYOUT_CONTAINER_STYLE,
    contentStyle: content ? getCustomLayoutSlotStyle(content, 1) : null,
  };
}

/** Reorders (and filters) stage entries to a plan's item order. */
export function orderStageEntriesByIds<T>(entries: T[], itemOrder: string[], getId: (entry: T) => string): T[] {
  const byId = new Map(entries.map((entry) => [getId(entry), entry]));
  return itemOrder.map((id) => byId.get(id)).filter((entry): entry is T => entry !== undefined);
}

export function findCustomLayout(layouts: CustomLayout[], id: string | null | undefined): CustomLayout | null {
  if (!id) return null;
  return layouts.find((layout) => layout.id === id) || null;
}

export function customLayoutHasContentSlot(layout: CustomLayout | null | undefined): boolean {
  return Boolean(layout?.slots.some((slot) => slot.kind === 'content'));
}
