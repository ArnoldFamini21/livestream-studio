import { useEffect, useId, useRef, useState } from 'react';
import { useTranscriptionJob } from '../hooks/useTranscriptionJob.ts';
import type { LocalRecordingFileRecord, LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import type { ClipCaptionStyle } from '../utils/clipCaptions.ts';
import { readRecordingTranscriptProject, saveRecordingTranscriptProject } from '../utils/recordingTranscriptProject.ts';
import { selectRecordingTranscriptionCandidate, type RecordingTranscriptionResult } from '../utils/recordingTranscription.ts';
import { createTranscriptEditDraft, type RecordingTranscriptProject } from '../utils/transcriptEditing.ts';
import { TranscriptCleanup } from './TranscriptCleanup.tsx';
import { TranscriptionEngineControls } from './TranscriptionEngineControls.tsx';

interface RecordingTranscriptEditorProps {
  session: LocalRecordingSession;
  loadFiles: (sessionId: string) => Promise<LocalRecordingFileRecord[]>;
  initialTranscript?: RecordingTranscriptionResult | null;
  language?: string;
  captionStyle: ClipCaptionStyle;
  onDownload: (blob: Blob, fileName: string) => void;
  onClose: () => void;
}

function projectFor(file: LocalRecordingFileRecord, transcript: RecordingTranscriptionResult): RecordingTranscriptProject {
  return {
    sourceId: file.id,
    sourceSize: file.blob.size,
    transcript: { ...transcript, words: transcript.words?.slice().sort((a, b) => a.start - b.start || a.end - b.end) },
    edit: createTranscriptEditDraft(false),
  };
}

function findProjectSource(files: LocalRecordingFileRecord[], project: RecordingTranscriptProject) {
  return files.find((file) => file.id === project.sourceId
    && file.blob.size === project.sourceSize && file.fileName === project.transcript.sourceFileName);
}

export function RecordingTranscriptEditor({
  session,
  loadFiles,
  initialTranscript,
  language,
  captionStyle,
  onDownload,
  onClose,
}: RecordingTranscriptEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [files, setFiles] = useState<LocalRecordingFileRecord[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [project, setProject] = useState<RecordingTranscriptProject | null>(null);
  const [saved, setSaved] = useState<RecordingTranscriptProject | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
  const job = useTranscriptionJob();
  const latestProject = useRef(project);
  latestProject.current = project;
  const dirty = project !== saved;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadFiles(session.id),
      readRecordingTranscriptProject(session.id).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not reopen the saved edit.');
        return null;
      }),
    ]).then(([tracks, previous]) => {
      if (!active) return;
      setFiles(tracks);
      const previousSource = previous?.transcript?.words?.length ? findProjectSource(tracks, previous) : undefined;
      if (previous && previousSource) {
        setSaved(previous);
        setProject(previous);
        setSourceId(previousSource.id);
        return;
      }
      const initialSource = initialTranscript?.words?.length
        ? tracks.find((file) => file.fileName === initialTranscript.sourceFileName) : undefined;
      if (initialSource && initialTranscript) {
        setProject(projectFor(initialSource, initialTranscript));
        setSourceId(initialSource.id);
        return;
      }
      if (previous) setError('The track used by the saved edit is unavailable. Choose a track to start over.');
      const preferred = tracks.find((track) => track.kind === 'program')
        ?? selectRecordingTranscriptionCandidate(tracks) ?? tracks[0];
      setSourceId(preferred && 'id' in preferred ? String(preferred.id) : '');
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : 'Could not read recording tracks.');
      setFiles([]);
    });
    return () => { active = false; };
  }, [initialTranscript, loadFiles, session.id]);

  const source = files?.find((file) => file.id === sourceId);
  const requestClose = () => {
    if (dirty || saving) setCloseRequested(true);
    else onClose();
  };

  const generate = async () => {
    if (!source || job.progress) return;
    setError('');
    try {
      const transcript = await job.run(source, language);
      if (!transcript) return;
      if (!transcript.words?.length) {
        setError('No timed words were found. Try a track with speech or use the browser transcription engine.');
        return;
      }
      setProject(projectFor(source, transcript));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not generate a transcript.');
    }
  };

  const save = async (closeAfterwards: boolean) => {
    if (!project || saving) return;
    setSaving(true);
    setError('');
    try {
      await saveRecordingTranscriptProject(session.id, project);
      setSaved(project);
      if (closeAfterwards && latestProject.current === project) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this edit.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="recording-transcript-editor"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); requestClose(); }}
    >
      <div className="recording-transcript-editor__header">
        <div>
          <h2 id={titleId}>Transcript editor</h2>
          <p>{session.roomName}</p>
        </div>
        <button type="button" className="transcript-cleanup__button" onClick={requestClose}>Close editor</button>
      </div>
      <div className="recording-transcript-editor__body">
        {!files && <p role="status">Loading the saved recording…</p>}
        {files && !files.length && <p>No local tracks are available for this recording.</p>}
        {source && !project && <div className="recording-transcript-editor__source">
          <label htmlFor={titleId + '-source'}>Transcribe track</label>
          <select id={titleId + '-source'} disabled={Boolean(job.progress)} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
            {files?.map((file) => <option key={file.id} value={file.id}>{file.label} · {file.fileName}</option>)}
          </select>
          <TranscriptionEngineControls settings={job.settings} onChange={job.setSettings} progress={job.progress} busy={Boolean(job.progress)} onCancel={job.cancel} />
          <div className="transcript-cleanup__actions">
            <button type="button" className="transcript-cleanup__button is-primary" disabled={Boolean(job.progress)} onClick={() => void generate()}>
              {job.progress ? 'Generating transcript…' : 'Generate transcript'}
            </button>
          </div>
        </div>}
        {project && files && source && <TranscriptCleanup
          words={project.transcript.words ?? []}
          durationSeconds={project.transcript.durationSeconds ?? session.durationSeconds ?? 0}
          source={source}
          baseName={session.roomName}
          tracks={files}
          sourceTrackIndex={files.indexOf(source)}
          studioName={session.roomName}
          markers={session.markers}
          editor={{
            draft: project.edit,
            onChange: (edit) => setProject((current) => current && { ...current, edit }),
            captionStyle,
            mix: {
              settings: project.mix,
              onChange: (mix) => setProject((current) => current && { ...current, mix }),
            },
          }}
          onDownload={onDownload}
        />}
      </div>
      {error && <p className="recording-transcript-editor__error" role="alert">{error}</p>}
      {project && <footer className="recording-transcript-editor__footer">
        <p role="status">{saving ? 'Saving…' : dirty ? 'Unsaved edit' : 'Edit saved on this device'}</p>
        {closeRequested ? <>
          <button type="button" className="transcript-cleanup__button" onClick={() => setCloseRequested(false)}>Keep editing</button>
          <button type="button" className="transcript-cleanup__button" disabled={saving} onClick={onClose}>Close without saving</button>
          <button type="button" className="transcript-cleanup__button is-primary" disabled={saving} onClick={() => void save(true)}>Save and close</button>
        </> : <button type="button" className="transcript-cleanup__button is-primary" disabled={!dirty || saving} onClick={() => void save(false)}>Save edit</button>}
      </footer>}
    </dialog>
  );
}
