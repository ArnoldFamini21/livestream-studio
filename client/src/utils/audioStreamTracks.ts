type AudioTrackSource = Pick<MediaStream, 'getAudioTracks'> | null | undefined;

export function getLiveAudioTracks(stream: AudioTrackSource): MediaStreamTrack[] {
  return stream?.getAudioTracks().filter((track) => track.readyState === 'live') ?? [];
}

export function hasLiveAudioTracks(stream: AudioTrackSource): boolean {
  return getLiveAudioTracks(stream).length > 0;
}
