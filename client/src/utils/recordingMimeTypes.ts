export const VIDEO_MP4_MEDIA_RECORDER_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=h264,aac',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1.4D401E',
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=h264',
  'video/mp4',
] as const;

export const VIDEO_WEBM_MEDIA_RECORDER_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

export const AUDIO_MP4_MEDIA_RECORDER_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const;

export const AUDIO_WEBM_MEDIA_RECORDER_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

type MediaRecorderSupport = Pick<typeof MediaRecorder, 'isTypeSupported'> | undefined;

export function getSupportedMediaRecorderMimeType(
  candidates: readonly string[],
  mediaRecorder: MediaRecorderSupport = typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder
): string {
  if (!mediaRecorder || typeof mediaRecorder.isTypeSupported !== 'function') return '';
  return candidates.find((candidate) => {
    try {
      return mediaRecorder.isTypeSupported(candidate);
    } catch {
      return false;
    }
  }) || '';
}

export function getPreferredVideoRecordingMimeType(
  mediaRecorder?: MediaRecorderSupport
): string {
  return getSupportedMediaRecorderMimeType(
    [...VIDEO_MP4_MEDIA_RECORDER_TYPES, ...VIDEO_WEBM_MEDIA_RECORDER_TYPES],
    mediaRecorder
  );
}

export function getPreferredAudioRecordingMimeType(
  mediaRecorder?: MediaRecorderSupport
): string {
  return getSupportedMediaRecorderMimeType(
    [...AUDIO_MP4_MEDIA_RECORDER_TYPES, ...AUDIO_WEBM_MEDIA_RECORDER_TYPES],
    mediaRecorder
  );
}

export function getRecordingFileExtension(mimeType: string | undefined): string {
  const normalized = (mimeType || '').toLowerCase();
  if (normalized.includes('video/x-vp9')) return 'vp9';
  if (normalized.includes('video/x-vp8')) return 'vp8';
  if (normalized.includes('video/avc')) return 'h264';
  if (normalized.includes('audio/mp4')) return 'm4a';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  return 'webm';
}
