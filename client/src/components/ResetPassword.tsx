import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { confirmPasswordReset, readPasswordResetToken } from '../utils/accountAuth.ts';
import { getApiErrorMessage } from '../utils/apiClient.ts';
import '../styles/account-security.css';

const MIN_PASSWORD_LENGTH = 8;

/** Landing page for the emailed reset link: /reset-password#token=… */
export function ResetPassword() {
  const navigate = useNavigate();
  const [token] = useState(() => (typeof window === 'undefined' ? '' : readPasswordResetToken(window.location.hash)));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // Drop the token from the address bar and history once it has been read.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const submit = async () => {
    setError('');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await confirmPasswordReset({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not reset the password. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return <main className="reset-password-page">
    <div className="reset-password-card">
      <h1>Choose a new password</h1>
      {!token ? <>
        <p className="account-security__error" role="alert">This reset link is incomplete. Open the link from the email again, or request a new one from the sign-in form.</p>
        <Link className="account-security__forgot" to="/">Back to Studio</Link>
      </> : done ? <>
        <p className="account-security__notice" role="status">Your password was changed and you're signed in. Every other device was signed out.</p>
        <button type="button" className="account-security__primary" onClick={() => navigate('/')}>Continue to Studio</button>
      </> : <form
        className="account-security"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="account-security__input"
          type="password"
          placeholder="New password"
          aria-label="New password"
          autoComplete="new-password"
          autoFocus
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
        {error && <p className="account-security__error" role="alert">{error}</p>}
        <button type="submit" className="account-security__primary" disabled={busy || !password || !confirm}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>}
    </div>
  </main>;
}
