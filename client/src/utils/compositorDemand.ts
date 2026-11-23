/**
 * Offline program recordings need the same composed video frames as a live
 * stream, and so does the program return that backstage guests watch (also
 * before the show goes live).
 */
export function shouldRunCompositor(state: { live: boolean; mixRecording: boolean; localRecording: boolean; programReturn?: boolean }): boolean {
  return state.live || state.mixRecording || state.localRecording || Boolean(state.programReturn);
}
