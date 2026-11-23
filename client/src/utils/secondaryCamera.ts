const CAMERA_PARAM = 'camera';

export function isSecondaryCameraEntry(params: URLSearchParams): boolean {
  return params.get(CAMERA_PARAM) === '1';
}

/** The ordinary guest invite keeps its room access rules and any studio name. */
export function buildSecondaryCameraInvite(inviteUrl: string): string {
  const url = new URL(inviteUrl);
  url.searchParams.set(CAMERA_PARAM, '1');
  return url.href;
}

export function secondaryCameraSearch(enabled: boolean): string {
  return enabled ? '?' + CAMERA_PARAM + '=1' : '';
}

export function studioSeatStorageKey(roomId: string, cameraOnly: boolean): string {
  return cameraOnly ? roomId + ':camera' : roomId;
}
