import { useEffect, useState } from 'react';
import { PREMIERE_MAX_UPLOAD_BYTES, type PremiereStatus } from '@studio/shared';
import { getApiErrorMessage, requestJson, resolveMediaHttpUrl } from '../utils/apiClient.ts';
import { buildPrivateWatchUrl } from '../utils/watchAccess.ts';

interface PremiereTicket {
  watchId: string;
  startsAt: number;
  uploadToken: string;
  invite: string;
}

export function PremiereSetup({ roomId, hostToken, inviteBase, copy }: {
  roomId: string; hostToken: string; inviteBase: string; copy: (value: string) => Promise<void>;
}) {
  const [ticket, setTicket] = useState<PremiereTicket | null>(null);
  const [status, setStatus] = useState<PremiereStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [retry, setRetry] = useState(0);
  const route = `/api/rooms/${encodeURIComponent(roomId)}/premiere`;
  const mediaUrl = resolveMediaHttpUrl().replace(/\/+$/, '');
  const hostHeaders = { 'x-host-token': hostToken };

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void (async () => {
      try {
        const result = await requestJson<PremiereTicket>(route, { method: 'POST', headers: { 'x-host-token': hostToken }, signal: controller.signal });
        const response = await fetch(`${mediaUrl}/premieres/${encodeURIComponent(result.watchId)}/status`, {
          signal: controller.signal, headers: { Authorization: `Bearer ${result.uploadToken}` },
        });
        const payload = await response.json() as PremiereStatus & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'Could not check premiere storage.');
        setTicket(result);
        setStatus(payload);
      } catch (err) {
        if (!controller.signal.aborted) setError(getApiErrorMessage(err, 'Could not prepare a premiere.'));
      }
    })();
    return () => controller.abort();
  }, [hostToken, mediaUrl, retry, route]);

  const upload = async () => {
    if (!file || busy || !ticket || file.size > PREMIERE_MAX_UPLOAD_BYTES) return;
    setBusy(true);
    setError('');
    try {
      // Refresh the ticket after the file picker, which can stay open for minutes.
      const latest = await requestJson<PremiereTicket>(route, { method: 'POST', headers: hostHeaders });
      const response = await fetch(`${mediaUrl}/premieres/${encodeURIComponent(latest.watchId)}/upload`, {
        method: 'POST', body: file, signal: AbortSignal.timeout(10 * 60_000),
        headers: { Authorization: `Bearer ${latest.uploadToken}`, 'Content-Type': 'video/mp4' },
      });
      const payload = await response.json() as PremiereStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'The MP4 could not be saved.');
      setTicket(latest);
      setStatus(payload);
      setFile(null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'The MP4 could not be uploaded.'));
    } finally { setBusy(false); }
  };

  const starts = ticket && new Date(ticket.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const invite = ticket ? buildPrivateWatchUrl(`${inviteBase.replace(/\/+$/, '')}/watch/${encodeURIComponent(ticket.watchId)}`, ticket.invite) : '';
  return <div style={{ display: 'grid', gap: 12 }}>
    <h3>Scheduled premiere</h3>
    {error && <p className="workspace-alert" role="alert">{error}</p>}
    {!status && !error && <p role="status">Checking premiere storage…</p>}
    {!status && error && <button type="button" className="workspace-secondary" onClick={() => setRetry(value => value + 1)}>Check again</button>}
    {starts && <p>Scheduled for {starts}. Viewers join through the private watch page while you are offline.</p>}
    {status?.phase === 'missing' && <>
      <label>Premiere video<input type="file" accept="video/mp4,.mp4" disabled={busy} onChange={event => {
        const next = event.currentTarget.files?.[0] || null;
        setFile(next);
        setError(next && next.size > PREMIERE_MAX_UPLOAD_BYTES ? 'Choose an MP4 of up to 256 MB.' : '');
      }} /></label>
      <p>Upload one H.264 MP4 with AAC audio, up to 256 MB and two hours. Leave this dialog open until the video is saved.</p>
      <button type="button" className="workspace-secondary" onClick={() => void upload()} disabled={!file || !file.size || file.size > PREMIERE_MAX_UPLOAD_BYTES || busy}>
        {busy ? 'Uploading and checking video…' : 'Upload and schedule'}
      </button>
    </>}
    {status && status.phase !== 'missing' && <>
      <p role="status">The video is saved and scheduled.</p>
      <button type="button" className="workspace-secondary" onClick={() => void copy(invite).then(() => setCopied(true)).catch(() => setError('Could not copy the private viewing link.'))}>
        {copied ? 'Private link copied' : 'Copy private watch link'}
      </button>
    </>}
  </div>;
}
