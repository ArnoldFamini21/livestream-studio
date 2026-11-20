import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecordingExportArtifactStatus, RecordingExportJobResponse } from '@studio/shared';
import {
  DEFAULT_CLEANUP_OPTIONS,
  MAX_KEEP_RANGES,
  buildCleanedTranscriptText,
  buildCleanupPlan,
  formatRemovedTime,
  skipCutAt,
  spliceAudioChannels,
  type CleanupCut,
  type TimeRange,
  type TranscriptWord,
} from '../utils/transcriptCleanup.ts';
import { encodePcm16Wav } from '../utils/wavEncoder.ts';
import { buildCleanupEditListFiles, getTrackAlignmentSeconds, inferEditListTrackRole, mapKeepRangesToTrack, type EditListMarker } from '../utils/editListExport.ts';
import type { ClipCaptionStyle } from '../utils/clipCaptions.ts';
import { buildEditedClipCaptions, createTranscriptEditDraft, editTranscriptWordRange, limitTranscriptKeepRanges, type TranscriptEditDraft } from '../utils/transcriptEditing.ts';
import { CleanedVideoRender, type CleanedRenderTrack } from './CleanedVideoRender.tsx';

const PAUSE_THRESHOLDS = [0.7, 1, 1.5, 2, 3];
/** Decoding more than this in the browser risks running out of memory; the server export has no such limit. */
const MAX_LOCAL_RENDER_SECONDS = 90 * 60;

export interface TranscriptCleanupServerExport {
  run: (keepRanges: TimeRange[]) => Promise<RecordingExportJobResponse>;
  download: (job: RecordingExportJobResponse, artifact: RecordingExportArtifactStatus) => Promise<void>;
}

/**
 * Descript-style cleanup: the transcript shows which filler words, stutters,
 * and long pauses will be cut. Click any word to cut or keep it, preview the
 * result, then save cleaned audio, render the cleaned video to MP4 in this
 * browser, take an edit list (FCPXML/EDL/SRT) into a free editor, or, as an
 * opt-in, export on the media server.
 */
export function TranscriptCleanup({
  words,
  durationSeconds,
  source,
  baseName,
  onDownload,
  serverExport,
  serverExportUnavailableReason,
  tracks,
  sourceTrackIndex = -1,
  studioName,
  markers,
  editor,
}: {
  words: TranscriptWord[];
  durationSeconds: number;
  source: { blob: Blob; label: string } | null;
  baseName: string;
  onDownload: (blob: Blob, fileName: string) => void;
  serverExport?: TranscriptCleanupServerExport | null;
  serverExportUnavailableReason?: string;
  /** Every recorded track of the take, for the edit list and the browser render. */
  tracks?: CleanedRenderTrack[];
  /** Which of `tracks` was transcribed (the kept ranges are in its time). */
  sourceTrackIndex?: number;
  studioName?: string;
  markers?: EditListMarker[];
  editor?: { draft: TranscriptEditDraft; onChange: (draft: TranscriptEditDraft) => void; captionStyle: ClipCaptionStyle };
}) {
  const [localDraft, setLocalDraft] = useState(() => createTranscriptEditDraft(true));
  const draft = editor?.draft ?? localDraft;
  const { removeFillers, removeRepeats, shortenPauses, pauseThreshold, restored, manualWords, excerpt } = draft;
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [focusedWord, setFocusedWord] = useState(0);
  const selectionAnchor = useRef<number | null>(null);
  const [rendering, setRendering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [job, setJob] = useState<RecordingExportJobResponse | null>(null);
  const [downloadingId, setDownloadingId] = useState('');
  const [error, setError] = useState('');

  const plan = useMemo(() => buildCleanupPlan(words, durationSeconds, {
    ...DEFAULT_CLEANUP_OPTIONS,
    removeFillers,
    removeRepeats,
    shortenPauses,
    pauseThresholdSeconds: pauseThreshold,
    restored: new Set(restored),
    manualWords: new Set(manualWords),
  }), [durationSeconds, manualWords, pauseThreshold, removeFillers, removeRepeats, restored, shortenPauses, words]);

  const keepRanges = useMemo(() => limitTranscriptKeepRanges(plan.keepRanges, excerpt), [plan.keepRanges, excerpt]);
  const captionCues = useMemo(() => editor ? buildEditedClipCaptions(plan.words, keepRanges) : [], [Boolean(editor), plan.words, keepRanges]);
  const outputDuration = keepRanges.reduce((total, range) => total + range.endSeconds - range.startSeconds, 0);
  const exportBaseName = excerpt ? baseName + '_clip' : baseName;

  const changeDraft = (next: TranscriptEditDraft) => {
    (editor?.onChange ?? setLocalDraft)(next);
    setJob(null);
  };

  // Pause cuts keyed by the word they follow, for inline markers.
  const pauseAfterWord = useMemo(() => {
    const map = new Map<string, CleanupCut>();
    for (const cut of plan.cuts) {
      if (cut.reason !== 'pause') continue;
      map.set(cut.id.slice('pause:'.length).split('-')[0], cut);
    }
    return map;
  }, [plan.cuts]);

  // A restored pause has no cut, but its marker should stay so it can be cut again.
  const restoredPauses = useMemo(() => {
    const map = new Map<string, string>();
    for (const id of restored) {
      if (id.startsWith('pause:')) map.set(id.slice('pause:'.length).split('-')[0], id);
    }
    return map;
  }, [restored]);

  const toggleWord = (index: number) => {
    if (selecting) {
      const anchor = selectionAnchor.current;
      const start = anchor ?? index;
      setSelection([Math.min(start, index), Math.max(start, index)]);
      selectionAnchor.current = anchor === null ? index : null;
      setSelecting(anchor === null);
      return;
    }
    changeDraft(editTranscriptWordRange(draft, plan.words, [index, index], !plan.words[index].removed));
  };

  const togglePause = (id: string) => {
    changeDraft({
      ...draft,
      restored: restored.includes(id) ? restored.filter((value) => value !== id) : [...restored, id],
    });
  };

  const finishSelection = (mode: 'cut' | 'keep' | 'clip') => {
    if (!selection) return;
    if (mode === 'clip') {
      const [first, last] = selection;
      changeDraft({ ...draft, excerpt: { startSeconds: plan.words[first].start, endSeconds: plan.words[last].end } });
    } else {
      changeDraft(editTranscriptWordRange(draft, plan.words, selection, mode === 'cut'));
    }
    selectionAnchor.current = null;
    setSelecting(false);
    setSelection(null);
  };

  const programIndex = editor ? tracks?.findIndex((track) => track.kind === 'program') ?? -1 : -1;
  const program = tracks?.[programIndex];
  const previewSource = program ?? source;
  const previewIsVideo = Boolean(program || (source && tracks?.[sourceTrackIndex] && inferEditListTrackRole(tracks[sourceTrackIndex]) !== 'audio'));
  const previewShift = program && tracks && sourceTrackIndex >= 0 ? getTrackAlignmentSeconds(tracks, sourceTrackIndex)[programIndex] : 0;
  const previewRanges = useMemo(() => mapKeepRangesToTrack(keepRanges, previewShift).map(({ sourceStart, sourceEnd }) => ({
    startSeconds: sourceStart,
    endSeconds: sourceEnd,
  })), [keepRanges, previewShift]);
  const preview = useSkipPreview(previewSource?.blob ?? null, previewRanges);

  const renderCleanedAudio = useCallback(async () => {
    if (!source) return;
    setRendering(true);
    setError('');
    try {
      if (plan.durationSeconds > MAX_LOCAL_RENDER_SECONDS) {
        throw new Error('This recording is too long to clean in the browser. Use "Export cleaned video" instead.');
      }
      const sampleRate = 48_000;
      const context = new OfflineAudioContext(1, 1, sampleRate);
      const decoded = await context.decodeAudioData(await source.blob.arrayBuffer());
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
      const spliced = spliceAudioChannels(channels, decoded.sampleRate, keepRanges);
      onDownload(encodePcm16Wav(spliced, decoded.sampleRate), `${safeName(exportBaseName)}_${safeName(source.label)}_cleaned.wav`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clean the audio in this browser.');
    } finally {
      setRendering(false);
    }
  }, [exportBaseName, keepRanges, onDownload, plan.durationSeconds, source]);

  const exportCleanedVideo = useCallback(async () => {
    if (!serverExport) return;
    setExporting(true);
    setError('');
    setJob(null);
    try {
      const result = await serverExport.run(keepRanges);
      setJob(result);
      if (result.status === 'error') setError(result.error || 'The cleaned export failed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The cleaned export failed.');
    } finally {
      setExporting(false);
    }
  }, [keepRanges, serverExport]);

  const downloadArtifact = async (artifact: RecordingExportArtifactStatus) => {
    if (!job || !serverExport) return;
    setDownloadingId(artifact.id);
    setError('');
    try {
      await serverExport.download(job, artifact);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingId('');
    }
  };

  const nothingToCut = plan.cuts.length === 0 && excerpt === null;
  const noMedia = keepRanges.length === 0;
  const tooManyCuts = keepRanges.length > MAX_KEEP_RANGES;
  const editDisabled = noMedia || (!editor && nothingToCut);
  const editWords = useMemo(() => excerpt
    ? plan.words.filter((word) => (word.start + word.end) / 2 >= excerpt.startSeconds && (word.start + word.end) / 2 < excerpt.endSeconds)
    : plan.words, [excerpt, plan.words]);
  const editTracks = useMemo<CleanedRenderTrack[]>(() => {
    if (tracks && tracks.length > 0 && sourceTrackIndex >= 0 && sourceTrackIndex < tracks.length) return tracks;
    return source ? [{ label: source.label, fileName: `${safeName(source.label)}.${source.blob.type.includes('wav') ? 'wav' : 'webm'}`, type: source.blob.type, blob: source.blob }] : [];
  }, [source, sourceTrackIndex, tracks]);
  const editSourceIndex = editTracks === tracks ? sourceTrackIndex : 0;

  const downloadEditList = async () => {
    setError('');
    try {
      const files = buildCleanupEditListFiles({
        baseName: exportBaseName,
        tracks: editTracks,
        sourceIndex: editSourceIndex,
        keepRanges,
        words: editWords,
        markers,
      });
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const file of files) zip.file(file.name, file.text);
      onDownload(await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' }), `${safeName(exportBaseName)}_cleanup_edit_list.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the edit list.');
    }
  };
  const readyArtifacts = job?.artifacts.filter((artifact) => artifact.status === 'ready' && artifact.format !== 'json') || [];

  return <section className="transcript-cleanup" aria-label={editor ? 'Transcript edit' : 'Transcript cleanup'}>
    <header className="transcript-cleanup__header">
      <div>
        {!editor && <h3 className="transcript-cleanup__title">Clean up</h3>}
        <p className="transcript-cleanup__summary" aria-live="polite">
          {editor
            ? <>{excerpt ? 'Clip' : 'Edited duration'} <strong>{formatRemovedTime(outputDuration)}</strong> of {formatRemovedTime(plan.durationSeconds)}</>
            : nothingToCut ? 'Nothing to remove with these settings.'
            : <>Removes <strong>{formatRemovedTime(plan.removedSeconds)}</strong> of {formatRemovedTime(plan.durationSeconds)}</>}
        </p>
      </div>
    </header>

    <div className="transcript-cleanup__options">
      <Toggle checked={removeFillers} onChange={(value) => changeDraft({ ...draft, removeFillers: value })} label="Filler words" count={plan.counts.filler} />
      <Toggle checked={removeRepeats} onChange={(value) => changeDraft({ ...draft, removeRepeats: value })} label="Stutters" count={plan.counts.repeat} />
      <Toggle checked={shortenPauses} onChange={(value) => changeDraft({ ...draft, shortenPauses: value })} label="Pauses" count={plan.counts.pause} />
      {shortenPauses && <label className="transcript-cleanup__threshold">
        <span>longer than</span>
        <select value={pauseThreshold} onChange={(event) => changeDraft({ ...draft, pauseThreshold: Number(event.target.value) })}>
          {PAUSE_THRESHOLDS.map((seconds) => <option key={seconds} value={seconds}>{seconds}s</option>)}
        </select>
      </label>}
    </div>

    {editor && <>
      {previewIsVideo && preview.url && <video className="transcript-cleanup__preview" ref={preview.attach} src={preview.url} playsInline preload="metadata" aria-label="Edited video preview" />}
      <div className="transcript-cleanup__strip" aria-hidden="true">
        {keepRanges.map((range) => <span
          key={range.startSeconds}
          style={{ left: `${range.startSeconds / plan.durationSeconds * 100}%`, width: `${(range.endSeconds - range.startSeconds) / plan.durationSeconds * 100}%` }}
        />)}
      </div>
      <div className="transcript-cleanup__selection">
        <button type="button" className="transcript-cleanup__button" aria-pressed={selecting} onClick={() => {
          selectionAnchor.current = null;
          setSelection(null);
          setSelecting(!selecting);
        }}>
          {selecting ? 'Cancel selection' : 'Select passage'}
        </button>
        {selection && <>
          <button type="button" className="transcript-cleanup__button" onClick={() => finishSelection('cut')}>Cut passage</button>
          <button type="button" className="transcript-cleanup__button" onClick={() => finishSelection('keep')}>Restore passage</button>
          <button type="button" className="transcript-cleanup__button" onClick={() => finishSelection('clip')}>Use as clip</button>
        </>}
        {excerpt && <button type="button" className="transcript-cleanup__button" onClick={() => changeDraft({ ...draft, excerpt: null })}>Edit full take</button>}
      </div>
      {selecting && <p className="transcript-cleanup__hint" role="status">Select the first and last words.</p>}
    </>}
    {preview.url && (!editor || !previewIsVideo) && <audio ref={preview.attach} src={preview.url} preload="metadata" />}
    <div className="transcript-cleanup__text" role="group" aria-label="Timed transcript">
      {pauseAfterWord.get('start') && <button
        type="button"
        className="transcript-cleanup__pause is-cut"
        aria-pressed="true"
        title="Silence before the first word is trimmed. Select to keep it."
        onClick={() => togglePause(pauseAfterWord.get('start')!.id)}
      >
        {formatPause(pauseAfterWord.get('start')!.end - pauseAfterWord.get('start')!.start)}
      </button>}{' '}
      {plan.words.map((word) => {
        const pause = pauseAfterWord.get(String(word.index));
        const restoredPause = restoredPauses.get(String(word.index));
        const time = preview.time - previewShift;
        const current = preview.playing && time >= word.start && time < word.end;
        const inSelection = Boolean(selection && word.index >= selection[0] && word.index <= selection[1]);
        return <Fragment key={word.index}>
          <button
            type="button"
            className={[
              'transcript-cleanup__word',
              word.removed ? 'is-cut' : '',
              word.reason && !word.removed ? 'is-kept' : '',
              current ? 'is-current' : '',
              inSelection ? 'is-selected' : '',
            ].filter(Boolean).join(' ')}
            aria-pressed={selecting ? inSelection : word.removed}
            data-word={word.index}
            tabIndex={word.index === focusedWord ? 0 : -1}
            onFocus={() => setFocusedWord(word.index)}
            onKeyDown={(event) => {
              const shift = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
              if (!shift) return;
              event.preventDefault();
              const next = Math.max(0, Math.min(plan.words.length - 1, word.index + shift));
              event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-word="${next}"]`)?.focus();
            }}
            title={word.removed
              ? `${labelFor(word.reason)} — cut. Select to keep.`
              : word.reason ? `${labelFor(word.reason)} — kept. Select to cut.` : 'Select to cut this word.'}
            onClick={() => toggleWord(word.index)}
          >
            {word.word}
          </button>
          {pause && <button
            type="button"
            className="transcript-cleanup__pause is-cut"
            aria-pressed="true"
            title="Pause shortened. Select to keep it."
            onClick={() => togglePause(pause.id)}
          >
            {formatPause(pause.end - pause.start)}
          </button>}
          {restoredPause && !pause && <button
            type="button"
            className="transcript-cleanup__pause is-kept"
            aria-pressed="false"
            title="Pause kept. Select to shorten it."
            onClick={() => togglePause(restoredPause)}
          >
            pause
          </button>}
          {' '}
        </Fragment>;
      })}
    </div>
    <p className="transcript-cleanup__hint">Select a word to cut or restore it. Use the arrow keys to move between words.</p>

    {noMedia && <p className="transcript-cleanup__error" role="alert">Restore some words or select a longer passage to keep media in this edit.</p>}
    {tooManyCuts && <p className="transcript-cleanup__error" role="alert">
      This makes more than {MAX_KEEP_RANGES} cuts. Turn off a category or keep some cuts to export.
    </p>}
    {preview.error && <p className="transcript-cleanup__error" role="alert">{preview.error}</p>}
    {error && <p className="transcript-cleanup__error" role="alert">{error}</p>}

    <div className="transcript-cleanup__actions">
      <button type="button" className="transcript-cleanup__button" disabled={!previewSource || editDisabled || !previewRanges.length} onClick={preview.toggle}>
        {preview.playing ? 'Pause preview' : 'Preview edit'}
      </button>
      <button type="button" className="transcript-cleanup__button" disabled={!source || editDisabled || rendering || tooManyCuts} onClick={() => void renderCleanedAudio()}>
        {rendering ? 'Cleaning audio…' : 'Download cleaned audio'}
      </button>
      <button
        type="button"
        className="transcript-cleanup__button"
        disabled={editDisabled}
        onClick={() => onDownload(new Blob([`${buildCleanedTranscriptText({ ...plan, words: editWords })}\n`], { type: 'text/plain;charset=utf-8' }), `${safeName(exportBaseName)}_cleaned_transcript.txt`)}
      >
        Cleaned transcript
      </button>
      <button
        type="button"
        className="transcript-cleanup__button"
        disabled={editDisabled || tooManyCuts || editTracks.length === 0}
        title="FCPXML for DaVinci Resolve or Final Cut Pro, a CMX3600 EDL per track and re-timed SRT captions"
        onClick={() => void downloadEditList()}
      >
        Edit list (FCPXML · EDL · SRT)
      </button>
    </div>

    {editTracks.length > 0 && <CleanedVideoRender
      tracks={editTracks}
      sourceIndex={editSourceIndex}
      keepRanges={keepRanges}
      baseName={exportBaseName}
      studioName={studioName || baseName}
      disabled={editDisabled || tooManyCuts}
      excerpt={Boolean(excerpt)}
      captions={editor ? { cues: captionCues, style: editor.captionStyle } : undefined}
      onDownload={onDownload}
    />}

    {(serverExport || serverExportUnavailableReason) && <details className="transcript-cleanup__server">
      <summary>Media server export (optional)</summary>
      <p className="transcript-cleanup__hint">
        Re-encodes on the media server. The free server has a fraction of one CPU, so a long recording can take hours there; the browser render above is usually much faster.
      </p>
      <div className="transcript-cleanup__actions">
        <button
          type="button"
          className="transcript-cleanup__button"
          disabled={!serverExport || editDisabled || exporting || tooManyCuts}
          title={serverExport ? 'Export the cleaned final MP4, per-person videos, and audio stems on the media server' : serverExportUnavailableReason}
          onClick={() => void exportCleanedVideo()}
        >
          {exporting ? 'Exporting on the media server…' : 'Export on media server'}
        </button>
      </div>
      {!serverExport && serverExportUnavailableReason && <p className="transcript-cleanup__hint">{serverExportUnavailableReason}</p>}
    </details>}

    {readyArtifacts.length > 0 && <ul className="transcript-cleanup__artifacts">
      {readyArtifacts.map((artifact) => <li key={artifact.id}>
        <span>{artifact.label}</span>
        <button type="button" className="transcript-cleanup__link" disabled={Boolean(downloadingId)} onClick={() => void downloadArtifact(artifact)}>
          {downloadingId === artifact.id ? 'Downloading…' : artifact.format.toUpperCase()}
        </button>
      </li>)}
    </ul>}
  </section>;
}

function Toggle({ checked, onChange, label, count }: { checked: boolean; onChange: (value: boolean) => void; label: string; count: number }) {
  return <label className={`transcript-cleanup__toggle${checked ? ' is-on' : ''}`}>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span>{label}</span>
    {checked && <span className="transcript-cleanup__count">{count}</span>}
  </label>;
}

/**
 * Plays the source with the cuts skipped. Media time is checked every
 * animation frame rather than on `timeupdate`, which fires only ~4 times a
 * second and would let cut audio leak through.
 */
function useSkipPreview(blob: Blob | null, keepRanges: TimeRange[]) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const rangesRef = useRef(keepRanges);
  const frameRef = useRef(0);
  const [url, setUrl] = useState('');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [error, setError] = useState('');
  const attach = useCallback((node: HTMLMediaElement | null) => { mediaRef.current = node; }, []);
  rangesRef.current = keepRanges;

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    mediaRef.current?.pause();
    setPlaying(false);
  }, []);

  useEffect(() => {
    stop();
    setError('');
    const objectUrl = blob ? URL.createObjectURL(blob) : '';
    setUrl(objectUrl);
    return () => {
      cancelAnimationFrame(frameRef.current);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blob, stop]);

  const toggle = useCallback(() => {
    const media = mediaRef.current;
    if (!media || !rangesRef.current.length) return;
    if (!media.paused) {
      stop();
      return;
    }
    setError('');
    let lastPaint = -1;
    const tick = () => {
      if (media !== mediaRef.current) return;
      const jump = skipCutAt(rangesRef.current, media.currentTime);
      if (jump === Number.POSITIVE_INFINITY || media.ended || !rangesRef.current.length) {
        stop();
        return;
      }
      if (jump !== null) media.currentTime = jump;
      if (Math.abs(lastPaint - media.currentTime) > 0.10) {
        lastPaint = media.currentTime;
        setTime(lastPaint);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    media.currentTime = rangesRef.current[0].startSeconds;
    void media.play().then(() => {
      if (media !== mediaRef.current || media.paused) return;
      setPlaying(true);
      frameRef.current = requestAnimationFrame(tick);
    }).catch(() => setError('This browser could not play the preview.'));
  }, [stop]);

  return { attach, error, playing, time, toggle, url };
}

function labelFor(reason: string | null): string {
  if (reason === 'filler') return 'Filler word';
  if (reason === 'repeat') return 'Repeated word';
  if (reason === 'manual') return 'Your cut';
  return 'Word';
}

function formatPause(seconds: number): string {
  return `−${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

function safeName(value: string): string {
  return value.trim().replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'recording';
}
