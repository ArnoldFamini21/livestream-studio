import type { BroadcastOrientation, RtmpRelayDestination, StreamDestination } from '@studio/shared';
import type { MediaServerHealth } from './mediaServerHealth.ts';
import type { RtmpRelayOutputPresetId } from './rtmpRelayOutput.ts';

export type SecondaryProgramLayout = 'grid' | 'spotlight' | 'solo';
export const SECONDARY_OUTPUT_PRESET: RtmpRelayOutputPresetId = 'smooth-720p';

export const OTHER_PROGRAM_LAYOUTS: ReadonlyArray<{ value: SecondaryProgramLayout; label: string }> = [
  { value: 'grid', label: 'Grid' },
  { value: 'spotlight', label: 'Spotlight' },
  { value: 'solo', label: 'Solo' },
];

export function getSecondaryProgramOrientation(primary: BroadcastOrientation): BroadcastOrientation {
  return primary === 'landscape' ? 'portrait' : 'landscape';
}

export function getDualOutputSupport(health: MediaServerHealth, copyAvailable: boolean): string | null {
  if (!copyAvailable) return 'Simultaneous output needs browser H.264 encoding. Try an updated Chrome or Edge.';
  if (health.status === 'checking') return 'Checking simultaneous output support…';
  if (health.status === 'unavailable') return 'The media server is unavailable.';
  if (!health.dualOutput?.ready) return health.dualOutput?.message || 'This media server does not support simultaneous output.';
  return null;
}

export function planBroadcastDestinations(
  destinations: readonly StreamDestination[],
  orientation: BroadcastOrientation,
  dual: boolean,
): { primary: RtmpRelayDestination[]; secondary: RtmpRelayDestination[]; issue: string | null } {
  const primary: RtmpRelayDestination[] = [];
  const secondary: RtmpRelayDestination[] = [];
  for (const destination of destinations) {
    if (!destination.enabled) continue;
    const { id, name, rtmpUrl, streamKey } = destination;
    if (!dual) {
      primary.push({ id, name, rtmpUrl, streamKey });
      continue;
    }
    const output = destination.orientation ?? orientation;
    const group = output === orientation ? primary : secondary;
    group.push({ id, name, rtmpUrl, streamKey, orientation: output });
  }
  if (!dual) return { primary, secondary, issue: null };
  if (!primary.length || !secondary.length) {
    return { primary, secondary, issue: 'Switch on at least one landscape and one portrait destination.' };
  }
  const target = (destination: RtmpRelayDestination) => JSON.stringify([
    destination.rtmpUrl.trim().replace(/\/+$/, ''), destination.streamKey.trim().replace(/^\/+/, ''),
  ]);
  const primaryTargets = new Set(primary.map(target));
  return {
    primary,
    secondary,
    issue: secondary.some((destination) => primaryTargets.has(target(destination)))
      ? 'Use a different server URL or stream key for each output.'
      : null,
  };
}

export interface ProgramTileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const OUTER_MARGIN = 0.025;
const TILE_GAP = 0.015;
const STAGE: ProgramTileRect = { left: OUTER_MARGIN, top: OUTER_MARGIN, width: 1 - 2 * OUTER_MARGIN, height: 1 - 2 * OUTER_MARGIN };

function gridRects(count: number, columns: number, area: ProgramTileRect): ProgramTileRect[] {
  const rows = Math.ceil(count / columns);
  const width = (area.width - TILE_GAP * (columns - 1)) / columns;
  const height = (area.height - TILE_GAP * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const rowSize = Math.min(columns, count - row * columns);
    return {
      left: area.left + (columns - rowSize) * (width + TILE_GAP) / 2 + (index % columns) * (width + TILE_GAP),
      top: area.top + row * (height + TILE_GAP),
      width,
      height,
    };
  });
}

/** Normalized tile rectangles for the second canvas. The stage order determines the featured tile. */
export function getSecondaryProgramRects(orientation: BroadcastOrientation, layout: SecondaryProgramLayout, count: number): ProgramTileRect[] {
  if (count <= 0) return [];
  if (layout === 'solo' || count === 1) return [STAGE];

  const portrait = orientation === 'portrait';
  if (layout === 'grid') {
    const columns = portrait ? (count <= 3 ? 1 : 2) : Math.ceil(Math.sqrt(count));
    return gridRects(count, columns, STAGE);
  }

  const featured = portrait ? { ...STAGE, height: STAGE.height * 0.66 } : { ...STAGE, width: STAGE.width * 0.72 };
  const rest = portrait
    ? { ...STAGE, top: featured.top + featured.height + TILE_GAP, height: STAGE.height - featured.height - TILE_GAP }
    : { ...STAGE, left: featured.left + featured.width + TILE_GAP, width: STAGE.width - featured.width - TILE_GAP };
  return [featured, ...gridRects(count - 1, portrait ? Math.min(count - 1, 3) : Math.ceil((count - 1) / 3), rest)];
}
