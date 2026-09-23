import { useCallback, useEffect, useState } from 'react';
import type { AccountSessionSummary } from '@studio/shared';
import {
  changeAccountPassword,
  fetchAccountCapabilities,
  fetchAccountSessions,
  requestPasswordReset,
  revokeAccountSession,
  revokeOtherAccountSessions,
} from '../utils/accountAuth.ts';
import { getApiErrorMessage } from '../utils/apiClient.ts';
import { describeLastActive, describeUserAgent } from '../utils/userAgentLabel.ts';
import '../styles/account-security.css';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Password and session management for a signed-in account: change the
 * password, see every device that is signed in, and sign devices out.
 */
export function AccountSecurity({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  const [open, setOpen] = useState<'none' | 'password' | 'sessions'>('none');

  return <div className="account-security">
    <div className="account-security__tabs" role="group" aria-label="Account security">
      <button
        type="button"
        className="account-security__tab"
        aria-expanded={open === 'password'}
        onClick={() => setOpen(open === 'password' ? 'none' : 'password')}
      >
        Change password
      </button>
      <button
        type="button"
        className="account-security__tab"
        aria-expanded={open === 'sessions'}
        onClick={() => setOpen(open === 'sessions' ? 'none' : 'sessions')}
      >
        Where you're signed in
      </button>
    </div>
    {open === 'password' && <ChangePasswordForm email={email} onDone={() => setOpen('none')} />}
    {open === 'sessions' && <SessionList onSignedOut={onSignedOut} />}
  </div>;
}

function ChangePasswordForm({ email, onDone }: { email: string; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async () => {
    setError('');
    setNotice('');
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const result = await changeAccountPassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setNotice(result.signedOutSessions > 0
        ? `Password changed. ${result.signedOutSessions} other ${result.signedOutSessions === 1 ? 'device was' : 'devices were'} signed out.`
        : 'Password changed.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not change the password. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return <form
    className="account-security__panel"
    onSubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    {/* Lets password managers attach the new password to this account. */}
    <input type="text" autoComplete="username" value={email} hidden readOnly />
    <input
      className="account-security__input"
      type="password"
      placeholder="Current password"
      aria-label="Current password"
      autoComplete="current-password"
      value={current}
      onChange={(event) => setCurrent(event.target.value)}
    />
    <input
      className="account-security__input"
      type="password"
      placeholder="New password"
      aria-label="New password"
      autoComplete="new-password"
      minLength={MIN_PASSWORD_LENGTH}
      maxLength={128}
      value={next}
      onChange={(event) => setNext(event.target.value)}
    />
    <input
      className="account-security__input"
      type="password"
      placeholder="Confirm new password"
      aria-label="Confirm new password"
      autoComplete="new-password"
      value={confirm}
      onChange={(event) => setConfirm(event.target.value)}
    />
    <p className="account-security__hint">Other devices are signed out when the password changes.</p>
    {error && <p className="account-security__error" role="alert">{error}</p>}
    {notice && <p className="account-security__notice" role="status">{notice}</p>}
    <div className="account-security__actions">
      <button type="button" className="account-security__ghost" onClick={onDone}>Close</button>
      <button type="submit" className="account-security__primary" disabled={busy || !current || !next || !confirm}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </div>
  </form>;
}

function SessionList({ onSignedOut }: { onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<AccountSessionSummary[] | null>(null);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setSessions((await fetchAccountSessions()).sessions);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not load your sessions.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = async (session: AccountSessionSummary) => {
    setBusyId(session.id);
    setError('');
    setNotice('');
    try {
      const result = await revokeAccountSession(session.id);
      if (result.revokedCurrent) {
        onSignedOut();
        return;
      }
      setSessions((current) => current?.filter((item) => item.id !== session.id) || null);
      setNotice(`Signed out ${describeUserAgent(session.userAgent)}.`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not sign that device out.'));
      void load();
    } finally {
      setBusyId('');
    }
  };

  const signOutOthers = async () => {
    setBusyId('others');
    setError('');
    setNotice('');
    try {
      const result = await revokeOtherAccountSessions();
      setSessions((current) => current?.filter((item) => item.current) || null);
      setNotice(result.revoked > 0
        ? `Signed out ${result.revoked} other ${result.revoked === 1 ? 'device' : 'devices'}.`
        : 'No other devices were signed in.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not sign out the other devices.'));
    } finally {
      setBusyId('');
    }
  };

  const others = sessions?.filter((session) => !session.current).length || 0;
  const now = Date.now();

  return <div className="account-security__panel">
    {!sessions && !error && <p className="account-security__hint">Loading…</p>}
    {sessions && <ul className="account-security__sessions">
      {sessions.map((session) => <li key={session.id} className="account-security__session">
        <span className="account-security__device" aria-hidden="true">{deviceGlyph(session.userAgent)}</span>
        <span className="account-security__sessionText">
          <span className="account-security__sessionName">
            {describeUserAgent(session.userAgent)}
            {session.current && <span className="account-security__badge">This device</span>}
          </span>
          <span className="account-security__sessionMeta">
            {session.current ? 'Active now' : describeLastActive(session.lastSeenAt, now)}
            {' · Signed in '}{formatDate(session.createdAt)}
          </span>
        </span>
        <button
          type="button"
          className="account-security__signOut"
          disabled={Boolean(busyId)}
          onClick={() => void signOut(session)}
        >
          {busyId === session.id ? 'Signing out…' : 'Sign out'}
        </button>
      </li>)}
    </ul>}
    {error && <p className="account-security__error" role="alert">{error}</p>}
    {notice && <p className="account-security__notice" role="status">{notice}</p>}
    {others > 0 && <div className="account-security__actions">
      <button type="button" className="account-security__danger" disabled={Boolean(busyId)} onClick={() => void signOutOthers()}>
        {busyId === 'others' ? 'Signing out…' : 'Sign out of all other devices'}
      </button>
    </div>}
  </div>;
}

/** "Forgot password?" for the sign-in form. */
export function ForgotPasswordForm({ defaultEmail, onClose }: { defaultEmail: string; onClose: () => void }) {
  const [email, setEmail] = useState(defaultEmail);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAccountCapabilities()
      .then((capabilities) => { if (!cancelled) setAvailable(capabilities.passwordReset); })
      .catch(() => { if (!cancelled) setAvailable(true); });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not send the reset email. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (available === false) {
    return <div className="account-security__panel">
      <p className="account-security__hint">Password reset by email isn't set up on this server. Ask the studio administrator to reset your password.</p>
      <div className="account-security__actions">
        <button type="button" className="account-security__ghost" onClick={onClose}>Back to sign in</button>
      </div>
    </div>;
  }

  if (sent) {
    return <div className="account-security__panel">
      <p className="account-security__notice" role="status">
        If an account exists for {email.trim()}, a reset link is on its way. It works for one hour.
      </p>
      <div className="account-security__actions">
        <button type="button" className="account-security__ghost" onClick={onClose}>Back to sign in</button>
      </div>
    </div>;
  }

  return <form
    className="account-security__panel"
    onSubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <p className="account-security__hint">Enter your account email and we'll send a link to choose a new password.</p>
    <input
      className="account-security__input"
      type="email"
      placeholder="Email"
      aria-label="Account email for password reset"
      autoComplete="email"
      value={email}
      onChange={(event) => setEmail(event.target.value)}
    />
    {error && <p className="account-security__error" role="alert">{error}</p>}
    <div className="account-security__actions">
      <button type="button" className="account-security__ghost" onClick={onClose}>Back to sign in</button>
      <button type="submit" className="account-security__primary" disabled={busy || !email.trim()}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </div>
  </form>;
}

function deviceGlyph(userAgent: string) {
  const mobile = /iPhone|Android.*Mobile|Mobile Safari/.test(userAgent);
  return mobile
    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></svg>
    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="4.5" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16.5V20" /></svg>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
