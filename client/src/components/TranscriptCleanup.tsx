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
 * result, then save cleaned audio here or export cleaned video on the server.
 */
export function TranscriptCleanup({
  words,
  durationSeconds,
  source,
  baseName,
  onDownload,
  serverExport,
  serverExportUnavailableReason,
}: {
  words: TranscriptWord[];
  durationSeconds: number;
  source: { blob: Blob; label: string } | null;
  baseName: string;
  onDownload: (blob: Blob, fileName: string) => void;
  serverExport?: TranscriptCleanupServerExport | null;
  serverExportUnavailableReason?: string;
}) {
  const [removeFillers, setRemoveFillers] = useState(true);
  const [removeRepeats, setRemoveRepeats] = useState(true);
  const [shortenPauses, setShortenPauses] = useState(true);
  const [pauseThreshold, setPauseThreshold] = useState(DEFAULT_CLEANUP_OPTIONS.pauseThresholdSeconds);
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  const [manualWords, setManualWords] = useState<Set<number>>(() => new Set());
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
    restored,
    manualWords,
  }), [durationSeconds, manualWords, pauseThreshold, removeFillers, removeRepeats, restored, shortenPauses, words]);

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
    const word = plan.words[index];
    if (word.reason && word.reason !== 'manual') {
      setRestored((current) => toggled(current, `word:${index}`));
    } else {
      setManualWords((current) => toggled(current, index));
    }
    setJob(null);
  };

  const togglePause = (id: string) => {
    setRestored((current) => toggled(current, id));
    setJob(null);
  };

  const preview = useSkipPreview(source?.blob || null, plan.keepRanges);

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
      const spliced = spliceAudioChannels(channels, decoded.sampleRate, plan.keepRanges);
      onDownload(encodePcm16Wav(spliced, decoded.sampleRate), `${safeName(baseName)}_${safeName(source.label)}_cleaned.wav`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clean the audio in this browser.');
    } finally {
      setRendering(false);
    }
  }, [baseName, onDownload, plan.durationSeconds, plan.keepRanges, source]);

  const exportCleanedVideo = useCallback(async () => {
    if (!serverExport) return;
    setExporting(true);
    setError('');
    setJob(null);
    try {
      const result = await serverExport.run(plan.keepRanges);
      setJob(result);
      if (result.status === 'error') setError(result.error || 'The cleaned export failed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The cleaned export failed.');
    } finally {
      setExporting(false);
    }
  }, [plan.keepRanges, serverExport]);

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

  const nothingToCut = plan.cuts.length === 0;
  const readyArtifacts = job?.artifacts.filter((artifact) => artifact.status === 'ready' && artifact.format !== 'json') || [];

  return <section className="transcript-cleanup" aria-label="Transcript cleanup">
    <header className="transcript-cleanup__header">
      <div>
        <h3 className="transcript-cleanup__title">Clean up</h3>
        <p className="transcript-cleanup__summary" aria-live="polite">
          {nothingToCut
            ? 'Nothing to remove with these settings.'
            : <>Removes <strong>{formatRemovedTime(plan.removedSeconds)}</strong> of {formatRemovedTime(plan.durationSeconds)}</>}
        </p>
      </div>
    </header>

    <div className="transcript-cleanup__options">
      <Toggle checked={removeFillers} onChange={(value) => { setRemoveFillers(value); setJob(null); }} label="Filler words" count={plan.counts.filler} />
      <Toggle checked={removeRepeats} onChange={(value) => { setRemoveRepeats(value); setJob(null); }} label="Stutters" count={plan.counts.repeat} />
      <Toggle checked={shortenPauses} onChange={(value) => { setShortenPauses(value); setJob(null); }} label="Pauses" count={plan.counts.pause} />
      {shortenPauses && <label className="transcript-cleanup__threshold">
        <span>longer than</span>
        <select value={pauseThreshold} onChange={(event) => { setPauseThreshold(Number(event.target.value)); setJob(null); }}>
          {PAUSE_THRESHOLDS.map((seconds) => <option key={seconds} value={seconds}>{seconds}s</option>)}
        </select>
      </label>}
    </div>

    <div className="transcript-cleanup__text" role="group" aria-label="Transcript. Select a word to cut or keep it.">
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
        const current = preview.playing && preview.time >= word.start && preview.time < word.end;
        return <Fragment key={word.index}>
          <button
            type="button"
            className={[
              'transcript-cleanup__word',
              word.removed ? 'is-cut' : '',
              word.reason && !word.removed ? 'is-kept' : '',
              current ? 'is-current' : '',
            ].filter(Boolean).join(' ')}
            aria-pressed={word.removed}
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
    <p className="transcript-cleanup__hint">Struck-through words and pauses are cut. Select any word to cut or keep it.</p>

    {plan.tooManyCuts && <p className="transcript-cleanup__error" role="alert">
      This makes more than {MAX_KEEP_RANGES} cuts. Turn off a category or keep some cuts to export.
    </p>}
    {error && <p className="transcript-cleanup__error" role="alert">{error}</p>}

    <div className="transcript-cleanup__actions">
      <button type="button" className="transcript-cleanup__button" disabled={!source || nothingToCut} onClick={preview.toggle}>
        {preview.playing ? 'Stop preview' : 'Preview cleaned'}
      </button>
      <button type="button" className="transcript-cleanup__button" disabled={!source || nothingToCut || rendering || plan.tooManyCuts} onClick={() => void renderCleanedAudio()}>
        {rendering ? 'Cleaning audio…' : 'Download cleaned audio'}
      </button>
      <button
        type="button"
        className="transcript-cleanup__button"
        disabled={nothingToCut}
        onClick={() => onDownload(new Blob([`${buildCleanedTranscriptText(plan)}\n`], { type: 'text/plain;charset=utf-8' }), `${safeName(baseName)}_cleaned_transcript.txt`)}
      >
        Cleaned transcript
      </button>
      <button
        type="button"
        className="transcript-cleanup__button is-primary"
        disabled={!serverExport || nothingToCut || exporting || plan.tooManyCuts}
        title={serverExport ? 'Export the cleaned final MP4, per-person videos, and audio stems on the media server' : serverExportUnavailableReason}
        onClick={() => void exportCleanedVideo()}
      >
        {exporting ? 'Exporting cleaned video…' : 'Export cleaned video'}
      </button>
    </div>
    {!serverExport && serverExportUnavailableReason && <p className="transcript-cleanup__hint">{serverExportUnavailableReason}</p>}

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
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const rangesRef = useRef(keepRanges);
  const frameRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  rangesRef.current = keepRanges;

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    mediaRef.current?.pause();
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!blob) return undefined;
    const url = URL.createObjectURL(blob);
    const media = new Audio(url);
    media.preload = 'auto';
    mediaRef.current = media;
    return () => {
      cancelAnimationFrame(frameRef.current);
      media.pause();
      mediaRef.current = null;
      URL.revokeObjectURL(url);
      setPlaying(false);
    };
  }, [blob]);

  const toggle = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (playing) {
      stop();
      return;
    }
    const tick = () => {
      const jump = skipCutAt(rangesRef.current, media.currentTime);
      if (jump === Number.POSITIVE_INFINITY || media.ended) {
        stop();
        return;
      }
      if (jump !== null) media.currentTime = jump;
      setTime(media.currentTime);
      frameRef.current = requestAnimationFrame(tick);
    };
    media.currentTime = rangesRef.current[0]?.startSeconds || 0;
    void media.play().then(() => {
      setPlaying(true);
      frameRef.current = requestAnimationFrame(tick);
    }).catch(() => setPlaying(false));
  }, [playing, stop]);

  return { playing, time, toggle };
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
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
