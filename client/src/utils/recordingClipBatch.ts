import type { ClipSuggestion } from './clipSuggestions.ts';
import { getClipDurationSeconds, getClipRangeIssue } from './recordingClips.ts';

export const MAX_BATCH_CLIPS = 6;
export const MAX_BATCH_CLIP_SECONDS = 90;

export function getBatchClipIssue(clip: ClipSuggestion): string | null {
  return getClipRangeIssue(clip) ?? (getClipDurationSeconds(clip) > MAX_BATCH_CLIP_SECONDS
    ? 'Over the 90-second batch clip limit.'
    : null);
}

export type ClipBatchEntry<Output> = {
  clip: ClipSuggestion;
} & (
  | { status: 'queued' }
  | { status: 'rendering'; progress: number }
  | { status: 'ready'; output: Output }
  | { status: 'failed'; error: string }
  | { status: 'stopped' }
);

export async function renderClipBatch<Output>(
  clips: readonly ClipSuggestion[],
  render: (clip: ClipSuggestion, progress: (fraction: number) => void, signal: AbortSignal) => Promise<Output>,
  update: (entry: ClipBatchEntry<Output>) => void,
  signal: AbortSignal,
): Promise<void> {
  if (clips.length > MAX_BATCH_CLIPS || new Set(clips.map((clip) => clip.id)).size !== clips.length) {
    throw new Error('Choose up to six different highlights.');
  }

  for (const clip of clips) {
    const issue = getBatchClipIssue(clip);
    if (signal.aborted) {
      update({ clip, status: 'stopped' });
    } else if (issue) {
      update({ clip, status: 'failed', error: issue });
    } else {
      update({ clip, status: 'rendering', progress: 0 });
      try {
        const output = await render(clip, (fraction) => {
          if (!signal.aborted && Number.isFinite(fraction)) {
            const progress = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
            update({ clip, status: 'rendering', progress });
          }
        }, signal);
        update(signal.aborted ? { clip, status: 'stopped' } : { clip, status: 'ready', output });
      } catch (error) {
        update(signal.aborted
          ? { clip, status: 'stopped' }
          : { clip, status: 'failed', error: error instanceof Error ? error.message : 'Could not render this clip.' });
      }
    }
  }
}
