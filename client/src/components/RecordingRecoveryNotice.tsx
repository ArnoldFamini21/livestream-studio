import { useCallback, useEffect, useState } from 'react';
import { persistRecordingSession } from '../hooks/useRecordingLibrary.ts';
import { listRecoverableRecordings, recoverRecording, type RecoverableRecording } from '../utils/recordingRecovery.ts';

export function RecordingRecoveryNotice({ onRecovered }: { onRecovered: () => Promise<void> }) {
  const [recordings, setRecordings] = useState<RecoverableRecording[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setRecordings(await listRecoverableRecordings()); }
    catch { setError('Could not check this browser for interrupted recordings.'); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
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
  if (!recordings.length && !error && !notice) return null;
  return <section className="recording-recovery" aria-label="Recording recovery">
    {recordings.length > 0 && <>
      <h3>Pick up where you left off</h3>
      <p>Recording footage is still saved in this browser. Interrupted recordings may be missing their final moments or need repair before playback.</p>
      <ul>{recordings.map(recording => <li key={recording.id}>
        <div><strong>{recording.roomName} · {recording.label}</strong><span>{new Date(recording.createdAt).toLocaleString()} · {recording.size < 1024 * 1024 ? `${Math.max(1, Math.round(recording.size / 1024))} KB` : `${(recording.size / 1024 / 1024).toFixed(1)} MB`} · {recording.complete ? 'Not yet saved to library' : 'Interrupted'}</span></div>
        <button type="button" disabled={busyId !== null} onClick={() => void recover(recording)}>{busyId === recording.id ? 'Recovering…' : 'Recover recording'}</button>
      </li>)}</ul>
    </>}
    {error && <p role="alert">{error} <button type="button" onClick={() => { setError(null); void refresh(); }}>Try again</button></p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
