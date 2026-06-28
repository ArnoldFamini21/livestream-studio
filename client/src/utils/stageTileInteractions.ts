export type StageTilePrimaryClickAction = 'spotlight' | 'clear-spotlight' | 'cycle-pip-corner' | 'none';

export interface StageTilePrimaryClickContext {
  canFocusTile: boolean;
  isFocusedTile: boolean;
  isPipSmallTile: boolean;
  isLeavingTile: boolean;
}

export function getStageTilePrimaryClickAction(context: StageTilePrimaryClickContext): StageTilePrimaryClickAction {
  if (context.isLeavingTile) return 'none';
  if (context.isPipSmallTile) return 'cycle-pip-corner';
  if (!context.canFocusTile) return 'none';
  return context.isFocusedTile ? 'clear-spotlight' : 'spotlight';
}
