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

export interface BrowserRecordingFormatSummary {
  videoMimeType: string;
  audioMimeType: string;
  videoExtension: string;
  audioExtension: string;
  supportsVideoMp4: boolean;
  supportsAudioMp4: boolean;
  label: string;
  detail: string;
}

export type RecordingFileFormatKind = 'mp4-video' | 'm4a-audio' | 'webm' | 'other';

export interface RecordingFileFormatSummary {
  totalFiles: number;
  mp4VideoCount: number;
  m4aAudioCount: number;
  webmCount: number;
  otherCount: number;
  hasFiles: boolean;
  allBrowserMp4Compatible: boolean;
  hasBrowserMp4CompatibleFiles: boolean;
  label: string;
  detail: string;
}

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

export function getRecordingBlobFormatKind(blobOrMimeType: Blob | string | undefined): RecordingFileFormatKind {
  const mimeType = typeof blobOrMimeType === 'string' ? blobOrMimeType : blobOrMimeType?.type;
  const normalized = (mimeType || '').toLowerCase();
  const extension = getRecordingFileExtension(mimeType);
  if (extension === 'mp4') return 'mp4-video';
  if (extension === 'm4a') return 'm4a-audio';
  if (extension === 'webm' && normalized.includes('webm')) return 'webm';
  return 'other';
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getRecordingBlob(input: Blob | { blob: Blob }): Blob {
  return 'blob' in input ? input.blob : input;
}

export function summarizeRecordingFileFormats(files: Array<Blob | { blob: Blob }>): RecordingFileFormatSummary {
  const counts = files.reduce(
    (next, file) => {
      const kind = getRecordingBlobFormatKind(getRecordingBlob(file));
      if (kind === 'mp4-video') next.mp4VideoCount += 1;
      if (kind === 'm4a-audio') next.m4aAudioCount += 1;
      if (kind === 'webm') next.webmCount += 1;
      if (kind === 'other') next.otherCount += 1;
      return next;
    },
    {
      mp4VideoCount: 0,
      m4aAudioCount: 0,
      webmCount: 0,
      otherCount: 0,
    }
  );
  const totalFiles = files.length;
  const browserMp4CompatibleCount = counts.mp4VideoCount + counts.m4aAudioCount;
  const hasFiles = totalFiles > 0;
  const hasBrowserMp4CompatibleFiles = browserMp4CompatibleCount > 0;
  const allBrowserMp4Compatible = hasFiles && browserMp4CompatibleCount === totalFiles;
  const countLabels = [
    counts.mp4VideoCount ? pluralize(counts.mp4VideoCount, 'MP4 video track') : '',
    counts.m4aAudioCount ? pluralize(counts.m4aAudioCount, 'M4A audio track') : '',
    counts.webmCount ? pluralize(counts.webmCount, 'WebM track') : '',
    counts.otherCount ? pluralize(counts.otherCount, 'browser fallback track') : '',
  ].filter(Boolean);

  if (!hasFiles) {
    return {
      totalFiles,
      ...counts,
      hasFiles,
      allBrowserMp4Compatible,
      hasBrowserMp4CompatibleFiles,
      label: 'No local recording files',
      detail: 'No finished recording tracks were available to save.',
    };
  }

  if (allBrowserMp4Compatible) {
    return {
      totalFiles,
      ...counts,
      hasFiles,
      allBrowserMp4Compatible,
      hasBrowserMp4CompatibleFiles,
      label: 'Browser-native MP4/M4A tracks',
      detail: `This browser produced ${countLabels.join(' and ')} that can be saved locally without WebM fallback.`,
    };
  }

  return {
    totalFiles,
    ...counts,
    hasFiles,
    allBrowserMp4Compatible,
    hasBrowserMp4CompatibleFiles,
    label: hasBrowserMp4CompatibleFiles ? 'Mixed MP4/WebM local tracks' : 'Browser fallback local tracks',
    detail: `This browser produced ${countLabels.join(', ')}. A single final MP4 mix still requires the media-server.`,
  };
}

export function getBrowserRecordingFormatSummary(
  mediaRecorder: MediaRecorderSupport = typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder
): BrowserRecordingFormatSummary {
  const videoMimeType = getPreferredVideoRecordingMimeType(mediaRecorder);
  const audioMimeType = getPreferredAudioRecordingMimeType(mediaRecorder);
  const videoExtension = videoMimeType ? getRecordingFileExtension(videoMimeType) : '';
  const audioExtension = audioMimeType ? getRecordingFileExtension(audioMimeType) : '';
  const supportsVideoMp4 = videoExtension === 'mp4';
  const supportsAudioMp4 = audioExtension === 'm4a';

  if (!videoMimeType && !audioMimeType) {
    return {
      videoMimeType,
      audioMimeType,
      videoExtension,
      audioExtension,
      supportsVideoMp4,
      supportsAudioMp4,
      label: 'Local save unsupported',
      detail: 'This browser does not expose a usable MediaRecorder container for local recording.',
    };
  }

  if (supportsVideoMp4 && supportsAudioMp4) {
    return {
      videoMimeType,
      audioMimeType,
      videoExtension,
      audioExtension,
      supportsVideoMp4,
      supportsAudioMp4,
      label: 'Local save: MP4 + M4A',
      detail: 'This browser can save local camera, screen, and program tracks as MP4, with audio-only tracks as M4A.',
    };
  }

  if (supportsVideoMp4) {
    return {
      videoMimeType,
      audioMimeType,
      videoExtension,
      audioExtension,
      supportsVideoMp4,
      supportsAudioMp4,
      label: 'Local save: MP4 video',
      detail: 'This browser can save local video tracks as MP4. Audio-only tracks may use the browser fallback container.',
    };
  }

  return {
    videoMimeType,
    audioMimeType,
    videoExtension,
    audioExtension,
    supportsVideoMp4,
    supportsAudioMp4,
    label: videoExtension ? `Local save: ${videoExtension.toUpperCase()}` : 'Local save: browser fallback',
    detail: 'This browser will save local video tracks in its fallback container. Use media-server export for final MP4 delivery.',
  };
}
