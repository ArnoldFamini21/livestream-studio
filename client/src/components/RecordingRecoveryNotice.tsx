import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { persistRecordingSession } from '../hooks/useRecordingLibrary.ts';
import { listRecoverableRecordings, recoverRecording, type RecoverableRecording } from '../utils/recordingRecovery.ts';
import { listPrivateRecoveryGrants, listPrivateRecoveryTakes, RECOVERY_CHANGED_EVENT } from '../utils/recordingCloudRecovery.ts';
import { PrivateRecordingBackups } from './PrivateRecordingBackups.tsx';

export function RecordingRecoveryNotice({ onRecovered, emptyState = null }: { onRecovered: () => Promise<void>; emptyState?: ReactNode }) {
  const [recordings, setRecordings] = useState<RecoverableRecording[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [privateTakes, setPrivateTakes] = useState(listPrivateRecoveryTakes);
  const [hasPrivateUpload, setHasPrivateUpload] = useState(() => listPrivateRecoveryGrants().length > 0);
  const refresh = useCallback(async () => {
    setPrivateTakes(listPrivateRecoveryTakes());
    setHasPrivateUpload(listPrivateRecoveryGrants().length > 0);
    try { setRecordings(await listRecoverableRecordings()); }
    catch { setError('Could not check this browser for interrupted recordings.'); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener(RECOVERY_CHANGED_EVENT, onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(RECOVERY_CHANGED_EVENT, onFocus);
    };
  }, [refresh]);
  const recover = async (recording: RecoverableRecording) => {
    setBusyId(recording.id); setError(null); setNotice(null);
    try {
      await recoverRecording(recording.id, persistRecordingSession);
      setRecordings(current => current.filter(item => item.id !== recording.id));
      setNotice('Recovered to your library. Preview or download the footage to check it.');
      await onRecovered();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Recovery failed. Your saved fragments have been kept.');
    } finally { setBusyId(null); }
  };
  if (!recordings.length && !error && !notice && !privateTakes.length && !hasPrivateUpload) return <>{emptyState}</>;
  return <section className="recording-recovery" aria-label="Recording recovery">
    {hasPrivateUpload && <p><Link to="/finish-upload">Finish upload</Link></p>}
    <PrivateRecordingBackups references={privateTakes} />
    {recordings.length > 0 && <>
      <h3>Recordings to recover</h3>
      <p>Saved on this device. Interrupted tracks may end early.</p>
      <ul>{recordings.map(recording => <li key={recording.id}>
        <div><strong>{recording.roomName} · {recording.label}</strong><span>{new Date(recording.createdAt).toLocaleString()} · {recording.size < 1024 * 1024 ? `${Math.max(1, Math.round(recording.size / 1024))} KB` : `${(recording.size / 1024 / 1024).toFixed(1)} MB`} · {recording.complete ? 'Not yet saved to library' : 'Interrupted'}</span></div>
        <button type="button" disabled={busyId !== null} onClick={() => void recover(recording)}>{busyId === recording.id ? 'Recovering…' : 'Recover recording'}</button>
      </li>)}</ul>
    </>}
    {error && <p role="alert">{error} <button type="button" onClick={() => { setError(null); void refresh(); }}>Try again</button></p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
