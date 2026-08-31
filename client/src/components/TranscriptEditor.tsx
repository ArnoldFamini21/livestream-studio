import React, { useCallback, useMemo, useState } from 'react';
import { formatClipTimecode } from '../utils/recordingClips.ts';
import type { RecordingTranscriptionResult } from '../utils/recordingTranscription.ts';
import {
  buildTranscriptEditorDocument,
  buildTranscriptEdl,
  DEFAULT_SILENCE_THRESHOLD_SECONDS,
  findTranscriptFillerRuns,
  findTranscriptSilenceGaps,
  getKeptTranscriptText,
  isTranscriptEditEmpty,
  summarizeTranscriptEdit,
  type TranscriptEdl,
  type TranscriptEditSummary,
} from '../utils/transcriptEditor.ts';

export interface TranscriptEditorExportRequest {
  edl: TranscriptEdl;
  summary: TranscriptEditSummary;
  transcriptText: string;
}

interface TranscriptEditorProps {
  transcript: RecordingTranscriptionResult;
  trackLabel: string;
  /** Renders the browser export button when the preview track can be re-encoded. */
  canExportInBrowser?: boolean;
  canExportOnMediaServer?: boolean;
  isExportingInBrowser?: boolean;
  isExportingOnMediaServer?: boolean;
  exportProgress?: number;
  error?: string | null;
  onExportInBrowser?: (request: TranscriptEditorExportRequest) => void;
  onExportOnMediaServer?: (request: TranscriptEditorExportRequest) => void;
  /** Seeks the preview player to a word the host clicked in the transcript. */
  onSeekToSeconds?: (seconds: number) => void;
}

const SILENCE_THRESHOLD_OPTIONS = [0.5, 0.75, 1, 1.5, 2];
const MAX_RENDERED_WORDS = 4000;

function formatDuration(seconds: number): string {
  return formatClipTimecode(Math.max(0, seconds));
}

export function TranscriptEditor({
  transcript,
  trackLabel,
  canExportInBrowser = false,
  canExportOnMediaServer = false,
  isExportingInBrowser = false,
  isExportingOnMediaServer = false,
  exportProgress = 0,
  error,
  onExportInBrowser,
  onExportOnMediaServer,
  onSeekToSeconds,
}: TranscriptEditorProps) {
  const [removedWordIds, setRemovedWordIds] = useState<string[]>([]);
  const [trimmedGapIds, setTrimmedGapIds] = useState<string[]>([]);
  const [includePhrases, setIncludePhrases] = useState(false);
  const [includeHedges, setIncludeHedges] = useState(false);
  const [silenceThreshold, setSilenceThreshold] = useState(DEFAULT_SILENCE_THRESHOLD_SECONDS);

  const doc = useMemo(
    () => buildTranscriptEditorDocument(transcript.words || [], transcript.durationSeconds),
    [transcript]
  );
  const fillerRuns = useMemo(
    () => findTranscriptFillerRuns(doc, { includePhrases, includeHedges }),
    [doc, includeHedges, includePhrases]
  );
  const silenceGaps = useMemo(
    () => findTranscriptSilenceGaps(doc, silenceThreshold),
    [doc, silenceThreshold]
  );
  const selection = useMemo(
    () => ({ removedWordIds, trimmedGapIds }),
    [removedWordIds, trimmedGapIds]
  );
  const edl = useMemo(() => buildTranscriptEdl(doc, selection), [doc, selection]);
  const summary = useMemo(() => summarizeTranscriptEdit(doc, selection), [doc, selection]);

  const removedWordSet = useMemo(() => new Set(removedWordIds), [removedWordIds]);
  const trimmedGapSet = useMemo(() => new Set(trimmedGapIds), [trimmedGapIds]);
  const gapsByWordIndex = useMemo(() => {
    const map = new Map<number, typeof silenceGaps[number]>();
    silenceGaps.forEach((gap) => map.set(gap.beforeWordIndex, gap));
    return map;
  }, [silenceGaps]);

  const pendingFillerWordIds = useMemo(() => (
    fillerRuns.flatMap((run) => run.wordIds).filter((id) => !removedWordSet.has(id))
  ), [fillerRuns, removedWordSet]);
  const pendingGapIds = useMemo(() => (
    silenceGaps.map((gap) => gap.id).filter((id) => !trimmedGapSet.has(id))
  ), [silenceGaps, trimmedGapSet]);

  const toggleWord = useCallback((wordId: string) => {
    setRemovedWordIds((current) => (
      current.includes(wordId) ? current.filter((id) => id !== wordId) : [...current, wordId]
    ));
  }, []);

  const toggleGap = useCallback((gapId: string) => {
    setTrimmedGapIds((current) => (
      current.includes(gapId) ? current.filter((id) => id !== gapId) : [...current, gapId]
    ));
  }, []);

  const removeAllFillers = useCallback(() => {
    setRemovedWordIds((current) => Array.from(new Set([...current, ...pendingFillerWordIds])));
  }, [pendingFillerWordIds]);

  const trimAllSilences = useCallback(() => {
    setTrimmedGapIds((current) => Array.from(new Set([...current, ...pendingGapIds])));
  }, [pendingGapIds]);

  const resetEdit = useCallback(() => {
    setRemovedWordIds([]);
    setTrimmedGapIds([]);
  }, []);

  const buildRequest = useCallback((): TranscriptEditorExportRequest => ({
    edl,
    summary,
    transcriptText: getKeptTranscriptText(doc, selection),
  }), [doc, edl, selection, summary]);

  const isUnedited = isTranscriptEditEmpty(edl);
  const isBusy = isExportingInBrowser || isExportingOnMediaServer;
  const renderedWords = doc.words.slice(0, MAX_RENDERED_WORDS);

  if (doc.words.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>Transcript Editor</div>
        <div style={styles.emptyNote}>
          This transcript has no word timings, so it cannot be edited by text. Regenerate the
          transcript with a Whisper model to get per-word timings.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Transcript Editor</span>
        <span style={styles.sourceLabel}>{transcript.sourceLabel}</span>
      </div>

      <div style={styles.summaryRow}>
        <span style={styles.summaryStrong}>
          {formatDuration(summary.keptSeconds)} of {formatDuration(summary.sourceDurationSeconds)}
        </span>
        <span style={styles.summaryMuted}>
          {summary.removedSeconds > 0
            ? `${formatDuration(summary.removedSeconds)} removed · ${Math.round(summary.tightenedFraction * 100)}% tighter`
            : 'Nothing removed yet'}
        </span>
        <span style={styles.summaryMuted}>
          {summary.removedWordCount} word{summary.removedWordCount === 1 ? '' : 's'} ·{' '}
          {summary.trimmedSilenceCount} silence{summary.trimmedSilenceCount === 1 ? '' : 's'} ·{' '}
          {summary.segmentCount} range{summary.segmentCount === 1 ? '' : 's'}
        </span>
      </div>

      <div style={styles.toolbar}>
        <button
          type="button"
          className="hover-lift"
          style={{ ...styles.toolBtn, ...(pendingFillerWordIds.length === 0 ? styles.toolBtnDisabled : {}) }}
          onClick={removeAllFillers}
          disabled={pendingFillerWordIds.length === 0 || isBusy}
          title="Remove every detected filler word from the edit"
        >
          Remove {pendingFillerWordIds.length} filler{pendingFillerWordIds.length === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          className="hover-lift"
          style={{ ...styles.toolBtn, ...(pendingGapIds.length === 0 ? styles.toolBtnDisabled : {}) }}
          onClick={trimAllSilences}
          disabled={pendingGapIds.length === 0 || isBusy}
          title="Shorten every detected pause to a natural breath"
        >
          Trim {pendingGapIds.length} silence{pendingGapIds.length === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          style={{ ...styles.toolBtn, ...(isUnedited ? styles.toolBtnDisabled : {}) }}
          onClick={resetEdit}
          disabled={isUnedited || isBusy}
        >
          Reset
        </button>
      </div>

      <div style={styles.optionsRow}>
        <label style={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={includePhrases}
            onChange={(event) => setIncludePhrases(event.target.checked)}
            disabled={isBusy}
          />
          Crutch phrases
        </label>
        <label style={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={includeHedges}
            onChange={(event) => setIncludeHedges(event.target.checked)}
            disabled={isBusy}
          />
          Hedges (like, basically)
        </label>
        <label style={styles.checkboxLabel}>
          Pauses over
          <select
            style={styles.select}
            value={silenceThreshold}
            onChange={(event) => setSilenceThreshold(Number(event.target.value))}
            disabled={isBusy}
          >
            {SILENCE_THRESHOLD_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}s</option>
            ))}
          </select>
        </label>
      </div>

      {includeHedges && (
        <div style={styles.hedgeNote}>
          Hedges are ordinary words in plenty of sentences — read the transcript before exporting.
        </div>
      )}

      <div style={styles.transcriptBody}>
        {renderedWords.map((word) => {
          const gap = gapsByWordIndex.get(word.index);
          const isRemoved = removedWordSet.has(word.id);
          return (
            <React.Fragment key={word.id}>
              {gap && (
                <button
                  type="button"
                  style={{ ...styles.gapChip, ...(trimmedGapSet.has(gap.id) ? styles.gapChipTrimmed : {}) }}
                  onClick={() => toggleGap(gap.id)}
                  disabled={isBusy}
                  title={`${gap.durationSeconds.toFixed(1)}s pause — click to ${trimmedGapSet.has(gap.id) ? 'restore' : 'trim'}`}
                >
                  {trimmedGapSet.has(gap.id) ? '✂' : '⏸'} {gap.durationSeconds.toFixed(1)}s
                </button>
              )}
              <button
                type="button"
                style={{ ...styles.word, ...(isRemoved ? styles.wordRemoved : {}) }}
                onClick={() => toggleWord(word.id)}
                onDoubleClick={() => onSeekToSeconds?.(word.startSeconds)}
                disabled={isBusy}
                title={`${formatClipTimecode(word.startSeconds)} — click to ${isRemoved ? 'restore' : 'remove'}, double-click to seek`}
              >
                {word.text}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {doc.words.length > MAX_RENDERED_WORDS && (
        <div style={styles.truncationNote}>
          Showing the first {MAX_RENDERED_WORDS.toLocaleString()} of {doc.words.length.toLocaleString()} words.
          Filler removal and silence trimming still apply to the whole transcript.
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {isBusy && exportProgress > 0 && (
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${Math.round(exportProgress * 100)}%` }} />
        </div>
      )}

      <div style={styles.exportRow}>
        {canExportInBrowser && (
          <button
            type="button"
            className="hover-lift"
            style={{ ...styles.exportBtn, ...(isUnedited || isBusy ? styles.toolBtnDisabled : {}) }}
            onClick={() => onExportInBrowser?.(buildRequest())}
            disabled={isUnedited || isBusy}
            title={`Re-encode ${trackLabel} in this browser with the edit applied`}
          >
            {isExportingInBrowser ? 'Exporting Edit...' : 'Export Edit'}
          </button>
        )}
        {canExportOnMediaServer && (
          <button
            type="button"
            className="hover-lift"
            style={{ ...styles.exportBtn, ...(isUnedited || isBusy ? styles.toolBtnDisabled : {}) }}
            onClick={() => onExportOnMediaServer?.(buildRequest())}
            disabled={isUnedited || isBusy}
            title="Render the edit on the media server across the program mix, isolated videos, and stems"
          >
            {isExportingOnMediaServer ? 'Rendering on Server...' : 'Export on Media Server'}
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
    border: '1px solid var(--border, rgba(255,255,255,0.08))',
    borderRadius: 10,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  sourceLabel: {
    fontSize: 11,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  summaryRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 10,
  },
  summaryStrong: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  summaryMuted: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  toolBtn: {
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 6,
    border: '1px solid var(--border, rgba(255,255,255,0.12))',
    background: 'transparent',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  toolBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  optionsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  select: {
    fontSize: 11,
    padding: '2px 4px',
    borderRadius: 4,
    border: '1px solid var(--border, rgba(255,255,255,0.12))',
    background: 'var(--bg-base, #1a1a1a)',
    color: 'var(--text-primary)',
  },
  hedgeNote: {
    fontSize: 10,
    lineHeight: 1.4,
    color: 'var(--warning, #f5a524)',
  },
  transcriptBody: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 2,
    maxHeight: 220,
    overflowY: 'auto',
    padding: 8,
    borderRadius: 8,
    background: 'var(--bg-base, rgba(0,0,0,0.25))',
    lineHeight: 1.7,
  },
  word: {
    padding: '1px 3px',
    fontSize: 12,
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  wordRemoved: {
    textDecoration: 'line-through',
    color: 'var(--text-muted)',
    opacity: 0.55,
  },
  gapChip: {
    padding: '0 5px',
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    border: '1px dashed var(--border, rgba(255,255,255,0.2))',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  gapChipTrimmed: {
    borderStyle: 'solid',
    color: 'var(--success, #17c964)',
    borderColor: 'var(--success, #17c964)',
  },
  truncationNote: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  emptyNote: {
    fontSize: 11,
    lineHeight: 1.5,
    color: 'var(--text-muted)',
  },
  error: {
    fontSize: 11,
    color: 'var(--danger, #f31260)',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    background: 'var(--border, rgba(255,255,255,0.12))',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: 'var(--accent, #6366f1)',
    transition: 'width 120ms linear',
  },
  exportRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  exportBtn: {
    padding: '7px 12px',
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent, #6366f1)',
    color: '#fff',
    cursor: 'pointer',
  },
};

export default TranscriptEditor;
