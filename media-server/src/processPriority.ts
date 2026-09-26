import os from 'node:os';

/** The lowest scheduling priority on Unix (nice 19). */
export const BACKGROUND_PROCESS_PRIORITY = 19;

/**
 * Recording exports are long 1080p encodes on the same server as the live
 * encoder. At normal priority, an export started mid-broadcast (stopping a
 * recording while live) competes with the live encode and viewers see
 * stutter. At the lowest priority the live encode always runs first and the
 * export uses what is left. Best effort: returns false if the OS refuses.
 */
export function runAtBackgroundPriority(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    os.setPriority(pid, BACKGROUND_PROCESS_PRIORITY);
    return true;
  } catch {
    return false;
  }
}
