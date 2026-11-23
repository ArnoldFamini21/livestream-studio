import { useEffect, useState } from 'react';
import type { RecordingRecoveryTake, RecordingRecoveryTrack } from '@studio/shared';
import { getHostSession } from '../utils/hostSession.ts';
import { getRecordingFileExtension } from '../utils/recordingMimeTypes.ts';
import {
  downloadPrivateRecoveryTrack, listPrivateRecoveryTakes, PrivateRecoveryError, readPrivateRecoveryTake,
  type PrivateRecoveryReference,
} from '../utils/recordingCloudRecovery.ts';

interface SaveFileWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

async function saveVerifiedTrack(reference: PrivateRecoveryReference, track: RecordingRecoveryTrack, hostToken: string) {
  const label = track.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'Recording';
  const filename = `${label}.${getRecordingFileExtension(track.mimeType)}`;
  const picker = (window as SaveFileWindow).showSaveFilePicker;
  const file = picker ? await picker.call(window, { suggestedName: filename }) : null;
  const response = await downloadPrivateRecoveryTrack(reference, track, hostToken);
  if (file && response.body) {
    await response.body.pipeTo(await file.createWritable());
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function PrivateRecordingTake({ reference, hostToken }: { reference: PrivateRecoveryReference; hostToken: string }) {
  const [take, setTake] = useState<RecordingRecoveryTake | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    let timer: number | undefined;
    setError('');
    const check = async () => {
      try {
        const result = await readPrivateRecoveryTake(reference, hostToken, request.signal);
        if (request.signal.aborted) return;
        setTake(result);
        setError('');
      } catch (failure) {
        if (request.signal.aborted) return;
        if (failure instanceof PrivateRecoveryError && [401, 403, 404, 410].includes(failure.status)) {
          setTake(null);
          setError(failure.message);
          return;
        }
        setError('Could not refresh the private backup. Trying again…');
      }
      timer = window.setTimeout(() => void check(), 15_000);
    };
    void check();
    return () => { request.abort(); window.clearTimeout(timer); };
  }, [hostToken, reference, reload]);

  const download = async (track: RecordingRecoveryTrack) => {
    setError('');
    setDownloading(`${track.participantId}:${track.trackId}`);
    try { await saveVerifiedTrack(reference, track, hostToken); }
    catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) {
        setError(failure instanceof Error ? failure.message : 'Could not download the verified track.');
      }
    } finally { setDownloading(''); }
  };

  return <div>
    {error && <p role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>Check again</button></p>}
    {!error && !take && <p role="status">Checking private backup…</p>}
    {take && <>
      <p>{take.tracks.filter(track => track.status === 'verified').length} tracks verified · Available until {new Date(take.expiresAt).toLocaleDateString()}</p>
      <ul>{take.participants.map(participant => {
        const tracks = take.tracks.filter(track => track.participantId === participant.participantId);
        return <li key={participant.participantId}><div>
          <strong>{participant.participantName}</strong>
          {tracks.length === 0 && <span>Awaiting upload</span>}
          {tracks.map(track => <div key={track.trackId}>
            <span>{track.label} · {track.status === 'verified' ? 'Verified' : 'Upload incomplete'}</span>
            {track.status === 'verified' && <button type="button" disabled={Boolean(downloading)} onClick={() => void download(track)}
              aria-label={`Download ${track.label}`}>
              {downloading === `${track.participantId}:${track.trackId}` ? 'Downloading…' : 'Download'}
            </button>}
          </div>)}
        </div></li>;
      })}</ul>
    </>}
  </div>;
}

export function PrivateRecordingBackups({ references }: { references: PrivateRecoveryReference[] }) {
  const [selected, setSelected] = useState('');
  if (!references.length) return null;
  return <div>
    <h3>Private backups</h3>
    {references.map(reference => {
      const key = `${reference.roomId}:${reference.takeId}`;
      const token = getHostSession(reference.roomId)?.hostToken;
      return <details key={key} open={selected === key} onToggle={event => {
        if (event.currentTarget.open) setSelected(key);
        else setSelected(current => current === key ? '' : current);
      }}>
        <summary>{reference.roomName} · {new Date(reference.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} expiry</summary>
        {selected === key && (token
          ? <PrivateRecordingTake reference={reference} hostToken={token} />
          : <p>This browser is missing the private host credential.</p>)}
      </details>;
    })}
  </div>;
}
