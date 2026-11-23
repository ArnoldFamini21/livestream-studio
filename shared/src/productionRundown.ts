export const MAX_RUNDOWN_ITEMS = 20;
export const MAX_RUNDOWN_TITLE = 100;
export const MAX_RUNDOWN_NOTES = 360;
export const MAX_RUNDOWN_SCENE_NAME = 100;

export interface ProductionRundownItem {
  id: string;
  title: string;
  notes: string;
  sceneName: string;
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
