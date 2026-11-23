/**
 * Offline program recordings need the same composed video frames as a live
 * stream, and so does the program return that backstage guests watch (also
 * before the show goes live). Warming the program during the record countdown
 * lets its live canvas track deliver frames before the encoder starts.
 */
export function shouldRunCompositor(state: { live: boolean; mixRecording: boolean; localRecording: boolean; programReturn?: boolean; preparingMixRecording?: boolean }): boolean {
  return state.live || state.mixRecording || state.localRecording || Boolean(state.programReturn || state.preparingMixRecording);
}
