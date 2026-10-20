import { useEffect, useRef, useState } from 'react';
import { useToast } from './Toast.tsx';
import {
  isRecordingFolderSaveSupported,
  pickRecordingFolder,
  saveRecordingToFolder,
  type RecordingFolderSaveInput,
  type RecordingFolderSaveResult,
} from '../utils/recordingFolderSave.ts';

interface RecordingFolderSaveProps {
  getRecording: () => RecordingFolderSaveInput | Promise<RecordingFolderSaveInput>;
  disabled?: boolean;
  compact?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

/** An explicit, independent copy of finished tracks; capture storage stays separate. */
export function RecordingFolderSave({ getRecording, disabled, compact = false, onBusyChange }: RecordingFolderSaveProps) {
  const { addToast } = useToast();
  const supported = isRecordingFolderSaveSupported();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RecordingFolderSaveResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const previewFile = saved?.files.find(({ file }) => file.type.startsWith('video/'))
    || saved?.files.find(({ file }) => file.type.startsWith('audio/'));

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!previewFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(previewFile.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewFile]);

  const save = async () => {
    if (savingRef.current || disabled || !supported) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    setProgress('Choose a folder…');
    let folderSelected = false;
    const protectSave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    try {
      onBusyChange?.(true);
      // The native picker needs the click's user activation. Load library files afterwards.
      const directory = await pickRecordingFolder();
      folderSelected = true;
      window.addEventListener('beforeunload', protectSave);
      if (mountedRef.current) setProgress('Preparing tracks…');
      const recording = await getRecording();
      const result = await saveRecordingToFolder(directory, recording, {
        onProgress: ({ completedFiles, totalFiles }) => {
          if (mountedRef.current) setProgress(`Saving ${completedFiles}/${totalFiles} tracks…`);
        },
      });
      if (mountedRef.current) { setSaved(result); setProgress(''); }
      else addToast(`Saved ${result.fileCount} tracks to ${result.folderName}. File sizes checked.`, 'success', { durationMs: 0 });
    } catch (failure) {
      const cancelled = !folderSelected && failure instanceof DOMException && failure.name === 'AbortError';
      const message = `${failure instanceof Error ? failure.message : 'Could not save to the selected folder.'} Keep this tab open and try again.`;
      if (mountedRef.current) {
        setProgress('');
        if (!cancelled) setError(message);
      } else if (!cancelled) addToast(message, 'error', { durationMs: 0 });
    } finally {
      window.removeEventListener('beforeunload', protectSave);
      onBusyChange?.(false);
      savingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className={`recording-folder-save${compact ? ' recording-folder-save--compact' : ''}`}>
      <button
        type="button"
        className="recording-folder-save-button"
        onClick={() => void save()}
        disabled={disabled || busy || !supported}
        title={supported ? 'Save original tracks to a folder on your drive' : 'Folder saving requires a supported browser such as desktop Chrome or Edge'}
      >
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M12 10v7m-3-3 3 3 3-3" />
        </svg>
        {busy ? 'Saving…' : 'Save to folder'}
      </button>
      {!compact && supported && <p className="recording-folder-save-help">Choose a folder on your external drive. Saves original tracks without a cloud upload. Browser recording storage is separate.</p>}
      {!supported && <p className="recording-folder-save-help">For folder saving, open this studio in desktop Chrome or Edge. You can also use the ZIP download and choose your drive in your browser’s download settings.</p>}
      {progress && <p role="status" className="recording-folder-save-status">{progress}</p>}
      {error && <p role="alert" className="recording-folder-save-error">{error}</p>}
      {saved && !busy && (
        <div className="recording-folder-save-result">
          <p role="status">Saved {saved.fileCount} track{saved.fileCount === 1 ? '' : 's'} to <strong>{saved.folderName}</strong>. File sizes checked.</p>
          {previewFile && previewUrl && (
            <details>
              <summary>Preview saved copy</summary>
              <p>{previewFile.label}</p>
              {previewFile.file.type.startsWith('video/')
                ? <video aria-label="Saved recording preview" src={previewUrl} controls playsInline preload="metadata" />
                : <audio aria-label="Saved recording preview" src={previewUrl} controls preload="metadata" />}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
