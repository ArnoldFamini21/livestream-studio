import { useState, type CSSProperties } from 'react';
import { getStoredStudioAccessKey, saveStudioAccessKey } from '../utils/studioAccessKey.ts';
import '../styles/studio-access-key.css';

/**
 * Shown in the Create studio dialog when the server answers that creating a
 * studio needs the owner's access key. The key is saved on this browser when
 * the host presses Create again.
 */
export function StudioAccessKeyField({
  value,
  onChange,
  onSubmit,
  inputStyle,
  labelStyle,
  fieldStyle,
  hintStyle,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputStyle?: CSSProperties;
  labelStyle?: CSSProperties;
  fieldStyle?: CSSProperties;
  hintStyle?: CSSProperties;
}) {
  return (
    <div className="ws-field" style={fieldStyle}>
      <label className="ws-label" style={labelStyle} htmlFor="studio-access-key">Studio access key</label>
      <input
        className="ws-input"
        style={inputStyle}
        id="studio-access-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="The key set as STUDIO_CREATE_SECRET"
        value={value}
        maxLength={512}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }}
      />
      <p className="ws-fieldHint" style={hintStyle}>Only the studio owner can create studios here. The key is remembered on this browser.</p>
    </div>
  );
}

/** Settings & account: keep, replace or forget the owner's studio access key on this browser. */
export function StudioAccessKeySettings() {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(() => Boolean(getStoredStudioAccessKey()));
  const [status, setStatus] = useState<string | null>(null);

  const save = () => {
    const key = saveStudioAccessKey(draft);
    setSaved(Boolean(key));
    setDraft('');
    setStatus(key ? 'Saved on this browser. New studios will use it.' : 'Enter a key to save it.');
  };
  const forget = () => {
    saveStudioAccessKey('');
    setSaved(false);
    setStatus('Removed from this browser.');
  };

  return (
    <section className="studio-access-key" aria-labelledby="studio-access-key-title">
      <h2 id="studio-access-key-title">Studio access key</h2>
      <p>
        When the server is set to owner-only studio creation, this browser sends the key with every new studio.
        {saved ? ' A key is saved on this browser.' : ' No key is saved on this browser.'}
      </p>
      <div className="studio-access-key-row">
        <input
          type="password"
          aria-label="Studio access key"
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          placeholder={saved ? 'Enter a new key to replace it' : 'Paste the studio access key'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && draft.trim()) save(); }}
        />
        <button type="button" disabled={!draft.trim()} onClick={save}>Save key</button>
        {saved && <button type="button" className="studio-access-key-forget" onClick={forget}>Forget key</button>}
      </div>
      {status && <p className="studio-access-key-status" role="status">{status}</p>}
    </section>
  );
}
