import { useMemo, useRef, useState } from 'react';
import type { TimeRange } from '../utils/transcriptCleanup.ts';
import { buildEditListTracks, type EditListTrackInput } from '../utils/editListExport.ts';
import { buildRenderFileName, getBrowserRenderSupport, type RenderProgress } from '../utils/cleanedRenderPlan.ts';
import { openRenderOutputFolder, type RenderOutputFolder } from '../utils/renderOutputFolder.ts';

export interface CleanedRenderTrack extends EditListTrackInput {
  blob: Blob;
}

interface RenderedFile {
  label: string;
  savedTo: string;
}

type RenderState =
  | { phase: 'idle' }
  | { phase: 'rendering'; label: string; position: number; count: number; progress: RenderProgress | null }
  | { phase: 'done'; files: RenderedFile[]; folder: RenderOutputFolder['kind']; folderLabel: string }
  | { phase: 'cancelled' }
  | { phase: 'error'; message: string; files: RenderedFile[] };

const PROGRESS_INTERVAL_MS = 250;

function defaultSelection(tracks: CleanedRenderTrack[], sourceIndex: number): Set<number> {
  const program = tracks.findIndex((track) => track.kind === 'program');
  if (program >= 0) return new Set([program]);
  const video = tracks.findIndex((track) => !(track.type || track.blob.type).startsWith('audio/'));
  if (video >= 0) return new Set([video]);
  return new Set([Math.max(0, sourceIndex)]);
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Renders the cleaned program (and any other tracks) to MP4 on this
 * computer: decoded, cut and re-encoded with WebCodecs, written straight
 * into the recording folder on the SSD (or downloaded).
 */
export function CleanedVideoRender({
  tracks,
  sourceIndex,
  keepRanges,
  baseName,
  studioName,
  disabled,
  onDownload,
}: {
  tracks: CleanedRenderTrack[];
  sourceIndex: number;
  keepRanges: TimeRange[];
  baseName: string;
  studioName: string;
  disabled?: boolean;
  onDownload: (blob: Blob, fileName: string) => void;
}) {
  const support = useMemo(() => getBrowserRenderSupport(), []);
  const [selected, setSelected] = useState<Set<number>>(() => defaultSelection(tracks, sourceIndex));
  const [state, setState] = useState<RenderState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const rendering = state.phase === 'rendering';

  const toggle = (index: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  });

  const start = async () => {
    if (rendering || selected.size === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const order = [...selected].filter((index) => tracks[index]).sort((a, b) => a - b);
    const files: RenderedFile[] = [];
    setState({ phase: 'rendering', label: tracks[order[0]]?.label || '', position: 1, count: order.length, progress: null });

    let folder: RenderOutputFolder;
    try {
      // First, while the click still counts: folder permission or picker.
      folder = await openRenderOutputFolder({ studioName });
    } catch (error) {
      setState(error instanceof DOMException && error.name === 'AbortError'
        ? { phase: 'idle' }
        : { phase: 'error', message: error instanceof Error ? error.message : 'No place to save the render.', files });
      return;
    }

    const editTracks = buildEditListTracks(tracks, sourceIndex, keepRanges);
    const { renderCleanedTrack, RenderCancelledError } = await import('../utils/cleanedRender.ts');
    for (const [position, index] of order.entries()) {
      const track = tracks[index];
      const isAudio = editTracks[index].role === 'audio';
      const extension = isAudio ? 'm4a' : 'mp4';
      let lastUpdate = 0;
      setState({ phase: 'rendering', label: track.label, position: position + 1, count: order.length, progress: null });
      let output;
      try {
        output = await folder.createFile(buildRenderFileName(baseName, track.label, extension), isAudio ? 'audio/mp4' : 'video/mp4');
        const result = await renderCleanedTrack({
          blob: track.blob,
          label: track.label,
          segments: editTracks[index].segments,
          output,
          signal: controller.signal,
          onProgress: (progress) => {
            const now = performance.now();
            if (now - lastUpdate < PROGRESS_INTERVAL_MS && progress.fraction < 1) return;
            lastUpdate = now;
            setState({ phase: 'rendering', label: track.label, position: position + 1, count: order.length, progress });
          },
        });
        const saved = await output.complete(result.buffer);
        if (saved.download) onDownload(saved.download, saved.savedTo);
        files.push({ label: track.label, savedTo: saved.savedTo });
      } catch (error) {
        await output?.discard();
        abortRef.current = null;
        if (error instanceof RenderCancelledError || controller.signal.aborted) {
          setState({ phase: 'cancelled' });
        } else {
          setState({ phase: 'error', message: `${track.label}: ${error instanceof Error ? error.message : 'The render failed.'}`, files });
        }
        return;
      }
    }
    abortRef.current = null;
    setState({ phase: 'done', files, folder: folder.kind, folderLabel: folder.label });
  };

  const cancel = () => abortRef.current?.abort();

  if (!support.supported) {
    return <div className="transcript-cleanup__render">
      <p className="transcript-cleanup__hint">{support.reason}</p>
    </div>;
  }

  const progress = state.phase === 'rendering' ? state.progress : null;
  const percent = progress ? Math.round(progress.fraction * 100) : 0;

  return <div className="transcript-cleanup__render" aria-label="Render cleaned video in this browser">
    <div className="transcript-cleanup__render-tracks" role="group" aria-label="Tracks to render">
      {tracks.map((track, index) => <label key={`${track.fileName}-${index}`} className={`transcript-cleanup__toggle${selected.has(index) ? ' is-on' : ''}`}>
        <input type="checkbox" checked={selected.has(index)} disabled={rendering} onChange={() => toggle(index)} />
        <span>{track.kind === 'program' ? `${track.label} (program)` : track.label}</span>
      </label>)}
    </div>
    <div className="transcript-cleanup__actions">
      {rendering
        ? <button type="button" className="transcript-cleanup__button" onClick={cancel}>Cancel render</button>
        : <button
          type="button"
          className="transcript-cleanup__button is-primary"
          disabled={disabled || selected.size === 0}
          title="Cut and re-encode on this computer with the browser's video encoder; nothing is uploaded"
          onClick={() => void start()}
        >
          Render cleaned MP4 here
        </button>}
    </div>
    {state.phase === 'rendering' && <div className="transcript-cleanup__progress" role="status" aria-live="polite">
      <div className="transcript-cleanup__progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span>
        {state.count > 1 ? `${state.position} of ${state.count} · ` : ''}{state.label}
        {progress ? ` · ${formatClock(progress.renderedSeconds)} of ${formatClock(progress.totalSeconds)}` : ' · starting…'}
      </span>
    </div>}
    {state.phase === 'rendering' && <p className="transcript-cleanup__hint">Keep this tab open until the render finishes.</p>}
    {state.phase === 'done' && <p className="transcript-cleanup__hint" role="status">
      {state.folder === 'recording-folder' || state.folder === 'picked-folder'
        ? <>Saved to <strong>{state.folderLabel}</strong>: {state.files.map((file) => file.savedTo.split('/').pop()).join(', ')}</>
        : <>Downloaded {state.files.map((file) => file.savedTo).join(', ')}</>}
    </p>}
    {state.phase === 'cancelled' && <p className="transcript-cleanup__hint" role="status">Render cancelled; the unfinished file was removed.</p>}
    {state.phase === 'error' && <p className="transcript-cleanup__error" role="alert">
      {state.message}{state.files.length > 0 ? ` (finished: ${state.files.map((file) => file.label).join(', ')})` : ''}
    </p>}
  </div>;
}
