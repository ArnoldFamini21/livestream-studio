import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ClipCaptionCue, ClipCaptionStyle } from '../utils/clipCaptions.ts';
import { buildRenderFileName, getBrowserRenderSupport } from '../utils/cleanedRenderPlan.ts';
import { getCleanedDurationSeconds, getTrackAlignmentSeconds, inferEditListTrackRole, mapKeepRangesToTrack } from '../utils/editListExport.ts';
import { getAlignedTrackStartMs } from '../utils/recordingTakeManifest.ts';
import {
  MAX_CAMERA_CUTS, MAX_MEMORY_MIX_SECONDS, MAX_MIX_GAIN_DB, MAX_MIX_SECONDS, MAX_MIX_TRACKS, MIN_MIX_GAIN_DB,
  clampMixGain, defaultTrackMixSetting, planMixPictureRuns, type RecordingTrackMixSettings,
} from '../utils/recordingTrackMix.ts';
import { createPreviewRenderOutput, type RenderOutputFile } from '../utils/renderOutputFolder.ts';
import type { TimeRange } from '../utils/transcriptCleanup.ts';
import type { CleanedRenderTrack } from './CleanedVideoRender.tsx';

type MixableTrack = CleanedRenderTrack & { id: string };
const INITIAL_MIX: RecordingTrackMixSettings = { tracks: {} };

interface MixPreview {
  blob: Blob;
  url: string;
  name: string;
}

interface MixRun {
  abort: AbortController;
  output?: RenderOutputFile;
  url?: string;
}

function releaseMix(run: MixRun | null) {
  if (!run) return;
  run.abort.abort();
  if (run.url) URL.revokeObjectURL(run.url);
  void run.output?.discard().catch(() => {});
}

export function RecordingTrackMix({
  tracks, sourceIndex, keepRanges, baseName, sourcePlayhead, value = INITIAL_MIX, onChange, disabled, captions, onDownload,
}: {
  tracks: CleanedRenderTrack[];
  sourceIndex: number;
  keepRanges: TimeRange[];
  baseName: string;
  sourcePlayhead: number;
  value?: RecordingTrackMixSettings;
  onChange: (value: RecordingTrackMixSettings) => void;
  disabled: boolean;
  captions?: { cues: ClipCaptionCue[]; style: ClipCaptionStyle };
  onDownload: (blob: Blob, fileName: string) => void;
}) {
  const id = useId();
  const support = useMemo(getBrowserRenderSupport, []);
  const candidates = useMemo(() => tracks.flatMap((track, index) => typeof track.id === 'string'
    ? [{ track: track as MixableTrack, index, role: track.kind === 'audio' ? 'audio' : inferEditListTrackRole(track) }]
    : []), [tracks]);
  const pictureTracks = candidates.filter(({ role }) => role !== 'audio');
  const audioTracks = candidates.filter(({ role }) => role === 'audio');
  const stems = audioTracks.map(({ track }) => track);
  const picture = pictureTracks.find(({ track }) => track.id === value.pictureId)
    ?? pictureTracks.find(({ track }) => track.kind === 'program') ?? pictureTracks[0];
  const cuts = value.cameraCuts ?? [];
  const [cutTime, setCutTime] = useState('');
  const [cutPictureId, setCutPictureId] = useState('');
  const nextPictureId = pictureTracks.find(({ track }) => track.id === cutPictureId)?.track.id
    ?? pictureTracks.find(({ track }) => track.id !== picture?.track.id)?.track.id ?? '';
  const audio = audioTracks.map(({ track, index }) => ({
    track, index, setting: value.tracks[track.id] ?? defaultTrackMixSetting(track, stems),
  }));

  const revision = useMemo(() => ({}), [tracks, keepRanges, sourceIndex, baseName, value, captions?.cues, captions?.style]);
  const active = useRef<MixRun | null>(null);
  const [preview, setPreview] = useState<(MixPreview & { revision: object }) | null>(null);
  const [progress, setProgress] = useState<{ revision: object; fraction: number } | null>(null);
  const [error, setError] = useState<{ revision: object; message: string } | null>(null);
  useEffect(() => {
    setPreview((current) => current?.revision === revision ? current : null);
    setProgress((current) => current?.revision === revision ? current : null);
    setError((current) => current?.revision === revision ? current : null);
    return () => {
      releaseMix(active.current);
      active.current = null;
    };
  }, [revision]);

  if (!picture || !audio.length) return null;
  const playing = preview?.revision === revision ? preview : null;
  const rendering = progress?.revision === revision;
  const duration = getCleanedDurationSeconds(keepRanges);
  const tooMany = audio.filter(({ setting }) => !setting.muted).length > MAX_MIX_TRACKS;
  const cannotRender = !support.supported || disabled || tooMany || duration > MAX_MIX_SECONDS;
  const selectedPictures = pictureTracks.filter(({ track }) => track.id === picture.track.id || cuts.some((cut) => cut.pictureId === track.id));
  const incompleteTiming = getAlignedTrackStartMs(tracks[sourceIndex]?.capture) === null
    || [...selectedPictures, ...audio.filter(({ setting }) => !setting.muted)].some(({ track }) => getAlignedTrackStartMs(track.capture) === null);
  const atSeconds = Math.round(Number(cutTime) * 100) / 100;
  const lastKeptTime = keepRanges.at(-1)?.endSeconds ?? 0;
  const canAddCut = cutTime.trim() && Number.isFinite(atSeconds) && atSeconds >= 0 && atSeconds < lastKeptTime
    && !cuts.some((cut) => cut.atSeconds === atSeconds) && nextPictureId && cuts.length < MAX_CAMERA_CUTS;

  const addCut = () => {
    if (!canAddCut) return;
    onChange({
      ...value,
      cameraCuts: [...cuts, { atSeconds, pictureId: nextPictureId }].sort((left, right) => left.atSeconds - right.atSeconds),
    });
    setCutTime('');
  };

  const render = async () => {
    if (rendering || cannotRender) return;
    releaseMix(active.current);
    const run: MixRun = { abort: new AbortController() };
    active.current = run;
    setPreview(null);
    setError(null);
    setProgress({ revision, fraction: 0 });
    try {
      const alignment = getTrackAlignmentSeconds(tracks, sourceIndex);
      const mixPictures = pictureTracks.map(({ track, index }) => ({ ...track, alignmentSeconds: alignment[index] }));
      const firstPicture = { ...picture.track, alignmentSeconds: alignment[picture.index] };
      const pictureRuns = cuts.length > 0 ? planMixPictureRuns(keepRanges, firstPicture, mixPictures, cuts) : undefined;
      const outputPicture = pictureRuns?.[0]?.picture ?? firstPicture;
      const segments = pictureRuns?.[0]?.segments ?? mapKeepRangesToTrack(keepRanges, firstPicture.alignmentSeconds);
      if (!segments.length) throw new Error('This picture track has no footage in the edited range. Choose another track.');
      const sources = audio.map(({ track, index, setting }) => ({
        ...setting, blob: track.blob, label: track.label, segments: mapKeepRangesToTrack(keepRanges, alignment[index]),
      }));
      const fileName = buildRenderFileName(baseName, 'mix', 'mp4');
      run.output = await createPreviewRenderOutput(fileName, 'video/mp4');
      run.abort.signal.throwIfAborted();
      if (!run.output.writable && duration > MAX_MEMORY_MIX_SECONDS) {
        throw new Error('This browser cannot create a temporary preview file. Use an excerpt of 90 seconds or less, or try Chrome or Edge.');
      }
      const { renderCleanedTrack } = await import('../utils/cleanedRender.ts');
      let lastProgress = 0;
      const result = await renderCleanedTrack({
        blob: outputPicture.blob,
        label: outputPicture.label,
        segments,
        pictureRuns,
        audioMix: { sources, durationSeconds: duration },
        output: run.output,
        captions,
        signal: run.abort.signal,
        onProgress: ({ fraction }) => {
          const now = performance.now();
          if (!run.abort.signal.aborted && (now - lastProgress >= 250 || fraction === 1)) {
            lastProgress = now;
            setProgress({ revision, fraction });
          }
        },
      });
      const { download } = await run.output.complete(result.buffer);
      run.abort.signal.throwIfAborted();
      if (!download) throw new Error('The mix did not produce a preview.');
      const blob = download.type === 'video/mp4' ? download : download.slice(0, download.size, 'video/mp4');
      run.url = URL.createObjectURL(blob);
      setPreview({ blob, url: run.url, name: fileName, revision });
    } catch (reason) {
      const cancelled = run.abort.signal.aborted;
      releaseMix(run);
      if (active.current === run && !cancelled) {
        setError({ revision, message: reason instanceof Error ? reason.message : 'Could not render this mix.' });
      }
      if (active.current === run) active.current = null;
    } finally {
      setProgress((current) => current?.revision === revision ? null : current);
    }
  };

  return <details className="transcript-cleanup__server transcript-mix">
    <summary>Multitrack mix</summary>
    <p className="transcript-cleanup__hint">Choose a picture track and balance the individual recordings. The preview uses the same file as the MP4 download.</p>
    <fieldset className="transcript-mix__controls" aria-label="Mix controls" disabled={rendering}>
      <label className="transcript-mix__picture">
        <span>{cuts.length ? 'Starting picture track' : 'Picture track'}</span>
        <select value={picture.track.id} onChange={(event) => onChange({ ...value, pictureId: event.currentTarget.value })}>
          {pictureTracks.map(({ track }) => <option key={track.id} value={track.id}>{track.label}</option>)}
        </select>
      </label>
      {(pictureTracks.length > 1 || cuts.length > 0) && <div className="transcript-mix__cameras">
        {cuts.length > 0 && <ul className="transcript-mix__tracks" aria-label="Camera cuts">
          {cuts.map((cut, index) => <li className="transcript-mix__picture" key={cut.atSeconds}>
            <span>{cut.atSeconds.toFixed(2)}s · {pictureTracks.find(({ track }) => track.id === cut.pictureId)?.track.label ?? 'Unavailable picture'}</span>
            <button className="transcript-cleanup__button" type="button" aria-label={`Remove cut at ${cut.atSeconds}s`}
              onClick={() => onChange({ ...value, cameraCuts: cuts.filter((_, position) => position !== index) })}>Remove</button>
          </li>)}
        </ul>}
        {cuts.length < MAX_CAMERA_CUTS && pictureTracks.length > 1 && <div className="transcript-mix__picture">
          <label>Cut time in take (s) <input type="number" min="0" step="0.01" inputMode="decimal" value={cutTime}
            onChange={(event) => setCutTime(event.currentTarget.value)} /></label>
          <button className="transcript-cleanup__button" type="button"
            onClick={() => setCutTime(Math.max(0, sourcePlayhead).toFixed(2))}>Use playhead</button>
          <label>Switch to <select value={nextPictureId} onChange={(event) => setCutPictureId(event.currentTarget.value)}>
            {pictureTracks.map(({ track }) => <option key={track.id} value={track.id}>{track.label}</option>)}
          </select></label>
          <button className="transcript-cleanup__button" type="button" disabled={!canAddCut} onClick={addCut}>Add camera cut</button>
        </div>}
      </div>}
      <ul className="transcript-mix__tracks">
        {audio.map(({ track, setting }, index) => {
          const gainId = `${id}-gain-${index}`;
          const gainDb = clampMixGain(setting.gainDb);
          const change = (next: typeof setting) => onChange({
            ...value, tracks: { ...value.tracks, [track.id]: next },
          });
          return <li className="transcript-mix__track" key={track.id}>
            <label htmlFor={gainId}>{track.label}</label>
            <input id={gainId} type="range" min={MIN_MIX_GAIN_DB} max={MAX_MIX_GAIN_DB} step={1}
              value={gainDb} aria-valuetext={`${gainDb} dB`} disabled={setting.muted}
              onChange={(event) => change({ ...setting, gainDb: Number(event.currentTarget.value) })} />
            <output htmlFor={gainId}>{gainDb > 0 ? '+' : ''}{gainDb} dB</output>
            <label className="transcript-mix__mute">
              <input type="checkbox" aria-label={`Mute ${track.label}`} checked={setting.muted}
                onChange={(event) => change({ ...setting, muted: event.currentTarget.checked })} />
              Mute
            </label>
          </li>;
        })}
      </ul>
    </fieldset>
    {incompleteTiming && <p className="transcript-cleanup__hint">Mix alignment is approximate for tracks without a capture start time.</p>}
    {tooMany && <p className="transcript-cleanup__hint">Keep up to {MAX_MIX_TRACKS} audio tracks unmuted.</p>}
    {duration > MAX_MIX_SECONDS && <p className="transcript-cleanup__hint">Choose a transcript excerpt of 10 minutes or less to render a mix.</p>}
    {!support.supported && <p className="transcript-cleanup__hint">{support.reason}</p>}
    <div className="transcript-cleanup__actions">
      <button className="transcript-cleanup__button" type="button" onClick={() => void render()} disabled={cannotRender || rendering}>
        {rendering ? 'Rendering mix…' : 'Preview mix'}
      </button>
      {rendering && <button className="transcript-cleanup__button" type="button" onClick={() => active.current?.abort.abort()}>
        Cancel mix
      </button>}
      {playing && <button className="transcript-cleanup__button is-primary" type="button" onClick={() => onDownload(playing.blob, playing.name)}>
        Download mixed MP4
      </button>}
    </div>
    {rendering && <progress className="transcript-mix__progress" aria-label="Mix render progress" value={progress?.fraction} max={1} />}
    {error?.revision === revision && <p role="alert" className="recording-transcript-editor__error">{error.message}</p>}
    {playing && <video className="transcript-cleanup__preview" controls playsInline preload="metadata" aria-label="Mixed recording preview" src={playing.url} />}
  </details>;
}
