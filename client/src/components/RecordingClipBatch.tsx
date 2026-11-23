import { useEffect, useRef, useState } from "react";
import type { ClipCaptionStyle } from "../utils/clipCaptions.ts";
import type { ClipSuggestion } from "../utils/clipSuggestions.ts";
import {
  getBatchClipIssue, MAX_BATCH_CLIPS, renderClipBatch, type ClipBatchEntry,
} from "../utils/recordingClipBatch.ts";
import { buildClipFileName, captureRecordingClip, formatClipTimecode, type ClipRenderOptions } from "../utils/recordingClips.ts";
import type { TranscriptWord } from "../utils/transcriptCleanup.ts";
import "../styles/recording-clip-batch.css";

export interface BatchClipOutput {
  blob: Blob;
  fileName: string;
  label: string;
  durationSeconds: number;
  warnings?: string[];
}

interface RecordingClipBatchProps {
  suggestions: ClipSuggestion[];
  source: { blob: Blob; name: string };
  speakerTracks: Blob[];
  captionWords: TranscriptWord[] | null;
  captionStyle: ClipCaptionStyle;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onDownload: (blob: Blob, fileName: string) => void;
  createArchive: (clips: BatchClipOutput[]) => Promise<Blob>;
  onSave: (clip: BatchClipOutput) => Promise<void>;
}

type Entry = ClipBatchEntry<BatchClipOutput>;
const keyFor = (clip: ClipSuggestion) => JSON.stringify([clip.id, clip.startSeconds, clip.endSeconds, clip.label]);
const lineFor = (clip: ClipSuggestion) => `${formatClipTimecode(clip.startSeconds)} – ${formatClipTimecode(clip.endSeconds)}`;

function ClipReview({ output }: { output: BatchClipOutput }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(output.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [output.blob]);
  return url ? <video aria-label={`Review ${output.label}`} src={url} controls playsInline preload="metadata" /> : null;
}

export function RecordingClipBatch({
  suggestions, source, speakerTracks, captionWords, captionStyle, disabled,
  onBusyChange, onDownload, createArchive, onSave,
}: RecordingClipBatchProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [smartFraming, setSmartFraming] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [packing, setPacking] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const renderController = useRef<AbortController | null>(null);
  const batchRenderOptions = useRef<ClipRenderOptions | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      renderController.current?.abort();
    };
  }, []);

  const chosen = suggestions.filter((clip) => !getBatchClipIssue(clip) && selected.includes(keyFor(clip)));
  const ready = entries.flatMap((entry) => entry.status === "ready" ? [entry.output] : []);
  const busy = disabled || running;
  const reviewBusy = busy || packing || savingId !== null;

  async function run(clips: ClipSuggestion[]) {
    if (disabled || renderController.current || clips.length === 0) return;
    const controller = new AbortController();
    renderController.current = controller;
    setRunning(true);
    setStopping(false);
    setError("");
    setReviewId(null);
    if (!batchRenderOptions.current) {
      batchRenderOptions.current = {
        smartCrop: smartFraming ? { speakerTracks } : null,
        captions: captions && captionWords?.length ? { words: captionWords, style: captionStyle } : null,
      };
    }
    const options = batchRenderOptions.current;
    onBusyChange(true);
    setEntries((previous) => previous.length
      ? previous.map((entry) => clips.some((clip) => clip.id === entry.clip.id) ? { clip: entry.clip, status: "queued" } : entry)
      : clips.map((clip) => ({ clip, status: "queued" })));

    try {
      await renderClipBatch(clips, async (clip, progress, signal) => {
        const result = await captureRecordingClip({ blob: source.blob, hasVideo: true, aspect: "vertical" }, clip, progress, {
          ...options, signal,
        });
        return {
          blob: result.blob,
          label: clip.label,
          fileName: buildClipFileName(source.name, clip.label, clip, result.extension, "vertical"),
          durationSeconds: result.durationSeconds,
          warnings: result.warnings,
        };
      }, (update) => {
        if (mounted.current) setEntries((previous) => previous.map((entry) => entry.clip.id === update.clip.id ? update : entry));
      }, controller.signal);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not render this batch.");
    } finally {
      renderController.current = null;
      onBusyChange(false);
      if (mounted.current) {
        setRunning(false);
        setStopping(false);
      }
    }
  }

  async function downloadZip() {
    if (reviewBusy || ready.length === 0) return;
    setPacking(true);
    setError("");
    try {
      const zip = await createArchive(ready);
      if (mounted.current) onDownload(zip, "vertical-clips.zip");
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not prepare the clip ZIP.");
    } finally {
      if (mounted.current) setPacking(false);
    }
  }

  async function save(id: string, output: BatchClipOutput) {
    if (reviewBusy || savedIds.includes(id)) return;
    setSavingId(id);
    setError("");
    try {
      await onSave(output);
      if (mounted.current) setSavedIds((ids) => [...ids, id]);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not save this clip to the library.");
    } finally {
      if (mounted.current) setSavingId(null);
    }
  }

  return (
    <details className="recording-clip-batch">
      <summary>Batch clips{running ? " · Rendering" : ready.length ? ` · ${ready.length} ready` : ""}</summary>
      {entries.length === 0 ? (
        <>
          <p>Choose up to {MAX_BATCH_CLIPS} highlights. Studio renders one 9:16 clip at a time.</p>
          <fieldset disabled={disabled}>
            <legend>Highlights</legend>
            {suggestions.map((clip) => {
              const issue = getBatchClipIssue(clip);
              const key = keyFor(clip);
              const checked = selected.includes(key);
              return (
                <label key={clip.id} className="recording-clip-batch__choice">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={Boolean(issue) || (!checked && chosen.length >= MAX_BATCH_CLIPS)}
                    onChange={(event) => {
                      const useClip = event.currentTarget.checked;
                      setSelected(useClip ? [...chosen.map(keyFor), key] : selected.filter((id) => id !== key));
                    }}
                  />
                  <span>{clip.label}<small>{lineFor(clip)}{issue ? ` · ${issue}` : ""}</small></span>
                </label>
              );
            })}
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>Clip options</legend>
            <label><input type="checkbox" checked={smartFraming} onChange={(event) => setSmartFraming(event.currentTarget.checked)} /> Smart framing</label>
            <label><input type="checkbox" checked={captions && Boolean(captionWords?.length)} disabled={!captionWords?.length} onChange={(event) => setCaptions(event.currentTarget.checked)} /> Burn in captions</label>
            {!captionWords?.length && <small>Save a timed transcript for this take to add captions.</small>}
          </fieldset>
          <button type="button" disabled={disabled || chosen.length === 0} onClick={() => void run(chosen)}>
            {chosen.length ? `Render ${chosen.length} ${chosen.length === 1 ? "clip" : "clips"}` : "Render clips"}
          </button>
        </>
      ) : (
        <>
          <p role="status">{running ? (stopping ? "Stopping…" : "Rendering clips in order…") : `${ready.length} of ${entries.length} clips ready`}</p>
          <ul>
            {entries.map((entry) => (
              <li key={entry.clip.id}>
                <strong>{entry.clip.label}</strong>
                <small>{lineFor(entry.clip)}</small>
                {entry.status === "queued" && <span>Queued</span>}
                {entry.status === "rendering" && <progress aria-label={`Rendering ${entry.clip.label}`} max={100} value={entry.progress} />}
                {entry.status === "failed" && <span role="alert">{entry.error}</span>}
                {entry.status === "stopped" && <span>Stopped</span>}
                {(entry.status === "failed" || entry.status === "stopped") && (
                  <button type="button" aria-label={`Retry ${entry.clip.label}`} disabled={reviewBusy} onClick={() => void run([entry.clip])}>Retry</button>
                )}
                {entry.status === "ready" && (
                  <>
                    {entry.output.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
                    <div className="recording-clip-batch__actions">
                      <button type="button" aria-expanded={reviewId === entry.clip.id} aria-label={`Review ${entry.clip.label}`} disabled={busy} onClick={() => setReviewId(reviewId === entry.clip.id ? null : entry.clip.id)}>{reviewId === entry.clip.id ? "Hide preview" : "Review"}</button>
                      <button type="button" aria-label={`Download ${entry.clip.label}`} onClick={() => onDownload(entry.output.blob, entry.output.fileName)}>Download</button>
                      <button type="button" aria-label={`Save ${entry.clip.label} to library`} disabled={reviewBusy || savedIds.includes(entry.clip.id)} onClick={() => void save(entry.clip.id, entry.output)}>
                        {savedIds.includes(entry.clip.id) ? "Saved" : savingId === entry.clip.id ? "Saving…" : "Save to library"}
                      </button>
                    </div>
                    {reviewId === entry.clip.id && <ClipReview output={entry.output} />}
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="recording-clip-batch__actions">
            {running ? <button type="button" disabled={stopping} onClick={() => { setStopping(true); renderController.current?.abort(); }}>Stop rendering</button> : (
              <button type="button" disabled={reviewBusy} onClick={() => {
                batchRenderOptions.current = null;
                setEntries([]);
                setSelected([]);
                setReviewId(null);
                setSavedIds([]);
                setError("");
              }}>New batch</button>
            )}
            {ready.length > 0 && <button type="button" disabled={reviewBusy} onClick={() => void downloadZip()}>{packing ? "Preparing ZIP…" : "Download ready clips as ZIP"}</button>}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
