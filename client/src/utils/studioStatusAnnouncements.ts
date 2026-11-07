export interface StudioBroadcastState {
  recording: boolean;
  paused: boolean;
  live: boolean;
}

/**
 * The sentence a screen reader should hear when recording or live state
 * changes, or null when nothing worth announcing changed.
 */
export function describeStudioStatusChange(previous: StudioBroadcastState | null, next: StudioBroadcastState): string | null {
  if (!previous) return null;
  const parts: string[] = [];
  if (!previous.live && next.live) parts.push('You are live.');
  if (previous.live && !next.live) parts.push('The live stream has ended.');
  if (!previous.recording && next.recording) parts.push(next.paused ? 'Recording started, paused.' : 'Recording started.');
  else if (previous.recording && !next.recording) parts.push('Recording stopped.');
  else if (previous.recording && next.recording && previous.paused !== next.paused) {
    parts.push(next.paused ? 'Recording paused.' : 'Recording resumed.');
  }
  return parts.length ? parts.join(' ') : null;
}
