import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listTransferableRecordings, type TransferableRecording } from '../utils/recordingRecovery.ts';
import { finalizeRecoverySource, listPrivateRecoveryGrants, uploadRecoveredTake, type PrivateRecoveryGrant } from '../utils/recordingCloudRecovery.ts';

interface PendingTake {
  grant: PrivateRecoveryGrant;
  recordings: TransferableRecording[];
}

export default function FinishRecordingUpload() {
  const [takes, setTakes] = useState<PendingTake[] | null>(null);
  const [working, setWorking] = useState('');
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let current = true;
    const check = async (delay = 0) => {
      if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
      if (!current) return;
      const pending = await Promise.all(listPrivateRecoveryGrants().map(async grant => ({
        grant,
        recordings: await listTransferableRecordings({ roomId: grant.roomId, sessionId: grant.takeId,
          participantId: grant.participantId, includeDelivered: true }),
      })));
      if (!current) return;
      // The studio may have just closed and still be flushing its final tracked data.
      if (delay === 0 && pending.length && pending.some(take => !take.recordings.length || take.recordings.some(track => !track.complete))) {
        void check(1800).catch(() => { if (current) setError('Could not read the recordings on this device.'); });
      }
      setTakes(pending);
    };
    void check().catch(() => { if (current) setError('Could not read the recordings on this device.'); });
    return () => { current = false; };
  }, [refresh]);

  useEffect(() => () => controller.current?.abort(), []);

  const finish = async ({ grant, recordings }: PendingTake) => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setError('');
    setProgress(0);
    setWorking(grant.takeId);
    try {
      await navigator.locks.request(`private-recording-upload:${grant.roomId}:${grant.takeId}:${grant.participantId}`,
        { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('This take is already uploading in another tab.');
          const sources = await Promise.all(recordings.filter(track => track.complete).map(async ({ id, blob, metadata }) => ({
            id, blob: await finalizeRecoverySource(blob), label: metadata.label, kind: metadata.kind, capture: metadata.transfer?.capture,
          })));
          await uploadRecoveredTake(grant, sources, {
            signal: request.signal,
            onProgress: (received, total) => setProgress(total ? Math.min(100, Math.round(received / total * 100)) : 0),
          });
        });
      if (!request.signal.aborted) setDone(current => new Set([...current, grant.takeId]));
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : 'Upload stopped. Your tracks are still saved on this device.');
    } finally {
      controller.current = null;
      setWorking('');
    }
  };

  return <main className="finish-recording-upload">
    <Link to="/" className="finish-recording-home">Studio</Link>
    <h1>Finish upload</h1>
    {error && <p role="alert">{error}</p>}
    {takes === null && !error && <p role="status">Checking this device…</p>}
    {takes?.length === 0 && <p>No private uploads are available on this device.</p>}
    {takes && takes.length > 0 && <ul>{takes.map(take => {
      const { grant, recordings } = take;
      const ready = recordings.filter(track => track.complete).length;
      const hasIncomplete = recordings.some(track => !track.complete);
      const active = working === grant.takeId;
      return <li key={`${grant.roomId}:${grant.takeId}:${grant.participantId}`}>
        <h2>{recordings[0]?.metadata.roomName || 'Studio recording'}</h2>
        {active ? <>
          <progress value={progress} max={100} aria-label="Uploading recording tracks" />
          <p role="status">{progress}% uploaded. Keep this tab open.</p>
          <button type="button" className="workspace-secondary" onClick={() => controller.current?.abort()}>Pause upload</button>
        </> : done.has(grant.takeId) ? <p role="status">{ready} {ready === 1 ? 'track' : 'tracks'} verified.</p> : ready > 0 ? <>
          <p>{ready} {ready === 1 ? 'track is' : 'tracks are'} ready to send to your host.</p>
          <button type="button" className="workspace-secondary" disabled={Boolean(working)} onClick={() => void finish(take)}>Finish upload</button>
        </> : <p>No completed tracks were found. If you recorded on another device, open this page there.</p>}
        {hasIncomplete && <p>Interrupted tracks are still available for local recovery.</p>}
      </li>;
    })}</ul>}
    {(error || takes?.some(take => !take.recordings.some(track => track.complete))) && !working && (
      <button type="button" className="workspace-secondary" onClick={() => { setError(''); setRefresh(value => value + 1); }}>Check this device again</button>
    )}
  </main>;
}
