/** Replace a disconnected device without changing the participant's privacy choice. */
export function replaceFallbackMediaTrack(
  stream: Pick<MediaStream, 'removeTrack' | 'addTrack'>,
  previousTrack: MediaStreamTrack | undefined,
  replacementTrack: MediaStreamTrack,
  sourceTrack?: MediaStreamTrack,
): boolean {
  const enabled = previousTrack?.enabled ?? false;
  // Apply the choice before adding the track: stream observers may publish it.
  replacementTrack.enabled = enabled;
  if (sourceTrack) sourceTrack.enabled = enabled;
  if (previousTrack) {
    stream.removeTrack(previousTrack);
    previousTrack.stop();
  }
  stream.addTrack(replacementTrack);
  return enabled;
}
