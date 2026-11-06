/** How long the pre-join "record and play back" mic check records. */
export const MIC_TEST_DURATION_MS = 3_000;

const MIC_TEST_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

/** The first audio format this browser can record (Safari: mp4, others: webm), or '' for the default. */
export function pickMicTestMimeType(isTypeSupported: ((type: string) => boolean) | undefined): string {
  if (!isTypeSupported) return '';
  return MIC_TEST_MIME_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  }) || '';
}

export type MicTestPhase = 'idle' | 'recording' | 'playing' | 'done' | 'error';

export function describeMicTestPhase(phase: MicTestPhase, secondsLeft: number): string {
  switch (phase) {
    case 'idle': return 'Record 3 seconds and hear how you sound.';
    case 'recording': return `Recording… say something (${secondsLeft}s)`;
    case 'playing': return 'Playing back your recording…';
    case 'done': return 'Did that sound clear? Record again any time.';
    case 'error': return 'The mic test could not run in this browser.';
  }
}
