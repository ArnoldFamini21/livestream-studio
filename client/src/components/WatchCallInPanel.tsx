import { useEffect, useState } from 'react';
import type { AudienceCallPublicStatus, AudienceCallReceipt } from '@studio/shared';
import { ApiRequestError, postJson, requestJson } from '../utils/apiClient.ts';
import { buildSecureGuestInviteUrl } from '../utils/inviteTokens.ts';
import { watchAuthHeaders } from '../utils/watchAccess.ts';

interface WatchCallInProps {
  enabled: boolean;
  watchId: string;
  watchAccessToken?: string;
  viewerId: string;
  nameHint: string;
}

function validReceipt(receipt: Partial<AudienceCallReceipt> | null): receipt is AudienceCallReceipt {
  const pattern = /^[A-Za-z0-9_-]{24}$/;
  return typeof receipt?.id === 'string' && typeof receipt.key === 'string' && pattern.test(receipt.id) && pattern.test(receipt.key);
}

const receiptKey = (watchId: string) => `studio:watch-call:${watchId}`;

export function WatchCallInPanel({ enabled, watchId, watchAccessToken, viewerId, nameHint }: WatchCallInProps) {
  const [receipt, setReceipt] = useState<AudienceCallReceipt | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(receiptKey(watchId)) || 'null') as Partial<AudienceCallReceipt> | null;
      return validReceipt(value) ? value : null;
    } catch {
      return null;
    }
  });
  const [status, setStatus] = useState<AudienceCallPublicStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(nameHint);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/watch/${encodeURIComponent(watchId)}/call-ins`;

  useEffect(() => {
    try {
      if (receipt) sessionStorage.setItem(receiptKey(watchId), JSON.stringify(receipt));
      else sessionStorage.removeItem(receiptKey(watchId));
    } catch { /* The request remains visible in this tab. */ }
  }, [receipt, watchId]);

  useEffect(() => {
    if (!receipt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await requestJson<AudienceCallPublicStatus>(`${path}/${receipt.id}`, {
          headers: { ...watchAuthHeaders(watchAccessToken), 'X-Watch-Call-Key': receipt.key },
          signal: controller.signal,
          timeoutMs: 8_000,
        });
        if (!controller.signal.aborted) {
          setStatus(result);
          if (result.state !== 'waiting') return;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setStatus({ state: 'expired' });
          return;
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, receipt, watchAccessToken]);

  useEffect(() => {
    if (status?.state !== 'approved') return;
    const timer = setTimeout(() => setStatus({ state: 'expired' }), Math.max(0, Date.parse(status.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [status]);

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = await postJson<AudienceCallReceipt>(path, { name: name.trim(), note: note.trim(), viewerId }, {
        headers: watchAuthHeaders(watchAccessToken),
      });
      if (!validReceipt(next)) throw new Error('The studio did not confirm your request.');
      setReceipt(next);
      setStatus({ state: 'waiting' });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your request.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!receipt) return;
    setBusy(true);
    setError('');
    try {
      await postJson(`${path}/${receipt.id}/cancel`, {}, {
        headers: { ...watchAuthHeaders(watchAccessToken), 'X-Watch-Call-Key': receipt.key },
      });
      setReceipt(null);
      setStatus({ state: 'cancelled' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel your request.');
    } finally {
      setBusy(false);
    }
  };

  if (!enabled && !receipt && !status) return null;
  const waiting = Boolean(receipt && (!status || status.state === 'waiting'));
  const joinUrl = status?.state === 'approved'
    ? buildSecureGuestInviteUrl(new URL(`/join/${encodeURIComponent(status.roomId)}`, window.location.origin).href, status.guestInvite)
    : '';
  return (
    <section className="watch-chat" aria-label="Audience call-in">
      <div className="watch-chat-head"><span className="watch-kicker">Join the conversation</span></div>
      {waiting && <p className="watch-chat-hint" role="status">Your request is with the studio team. You can keep watching while you wait.</p>}
      {waiting && <div className="watch-chat-row"><button type="button" className="watch-chat-cancel" onClick={() => void cancel()} disabled={busy}>Cancel request</button></div>}
      {joinUrl && <>
        <p className="watch-chat-hint" role="status">Your request was approved. Check your devices, then enter the green room. The host will decide when to bring you on stage.</p>
        <a className="watch-chat-ask" href={joinUrl}>Continue to device check</a>
      </>}
      {status?.state === 'declined' && <p className="watch-chat-hint" role="status">The studio did not accept this request.</p>}
      {status?.state === 'cancelled' && <p className="watch-chat-hint" role="status">Request cancelled.</p>}
      {status?.state === 'expired' && <p className="watch-chat-hint" role="status">This request has expired.</p>}
      {enabled && !waiting && !joinUrl && !open && <div className="watch-chat-actions">
        <button type="button" className="watch-chat-ask" onClick={() => { setOpen(true); setReceipt(null); setStatus(null); setName(nameHint); }}>Request to join</button>
      </div>}
      {enabled && open && <form className="watch-chat-form watch-chat-question" onSubmit={(event) => void request(event)}>
        <label className="watch-chat-name-field">Your name<input required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
        <label className="watch-chat-name-field">Note for the studio team (optional)<textarea rows={2} maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <p className="watch-chat-hint">The studio team can read your name and note.</p>
        <div className="watch-chat-row">
          <button type="submit" disabled={busy || !name.trim()}>Send request</button>
          <button type="button" className="watch-chat-cancel" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        </div>
      </form>}
      {error && <p className="watch-chat-status is-error" role="alert">{error}</p>}
    </section>
  );
}
