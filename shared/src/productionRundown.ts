import type { CameraShape, LayoutMode, NameTagStyle, Scene } from './index.js';

export const MAX_RUNDOWN_ITEMS = 20;
export const MAX_RUNDOWN_TITLE = 100;
export const MAX_RUNDOWN_NOTES = 360;
export const MAX_RUNDOWN_SCENE_NAME = 100;

export interface ProductionRundownScene {
  layout: Exclude<LayoutMode, 'custom'>;
  cameraShape?: CameraShape;
  nameTagStyle?: NameTagStyle;
  pipCorner?: Scene['pipCorner'];
  brandColor?: string;
  backgroundColor?: string;
}

const LAYOUTS = ['grid', 'spotlight', 'side-by-side', 'pip', 'single', 'featured'] as const;
const CAMERA_SHAPES = ['rectangle', 'rounded', 'square', 'circle'] as const;
const NAMETAG_STYLES = ['classic', 'minimal', 'block'] as const;
const PIP_CORNERS = ['TL', 'TR', 'BL', 'BR'] as const;

function select<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.find(option => option === value);
}

function hexColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : undefined;
}

/** Accept only portable layout controls. Media URLs and local library IDs never enter this snapshot. */
export function normalizeProductionRundownScene(value: unknown): ProductionRundownScene | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const layout = select(input.layout, LAYOUTS);
  if (!layout) return undefined;
  const cameraShape = select(input.cameraShape, CAMERA_SHAPES);
  const nameTagStyle = select(input.nameTagStyle, NAMETAG_STYLES);
  const pipCorner = select(input.pipCorner, PIP_CORNERS);
  const brandColor = hexColor(input.brandColor);
  const backgroundColor = hexColor(input.backgroundColor);
  return {
    layout,
    ...(cameraShape ? { cameraShape } : {}),
    ...(nameTagStyle ? { nameTagStyle } : {}),
    ...(pipCorner ? { pipCorner } : {}),
    ...(brandColor ? { brandColor } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
  };
}

export interface ProductionRundownItem {
  id: string;
  title: string;
  notes: string;
  sceneName: string;
  scene?: ProductionRundownScene;
}

export interface ProductionRundown {
  revision: number;
  items: ProductionRundownItem[];
  cueItemId: string | null;
  lastTakenItemId: string | null;
}

export type ProductionRundownCommand =
  | { action: 'save-item'; item: ProductionRundownItem }
  | { action: 'remove-item'; itemId: string }
  | { action: 'move-item'; itemId: string; direction: 'up' | 'down' }
  | { action: 'cue-item'; itemId: string | null }
  | { action: 'take-item'; itemId: string };

export type ProductionRundownUpdate = ProductionRundownCommand & {
  requestId: string;
  baseRevision: number;
};

export interface ProductionRundownStateMessage {
  rundown: ProductionRundown;
  requestId?: string;
  error?: string;
}

export const EMPTY_PRODUCTION_RUNDOWN: ProductionRundown = {
  revision: 0,
  items: [],
  cueItemId: null,
  lastTakenItemId: null,
};
