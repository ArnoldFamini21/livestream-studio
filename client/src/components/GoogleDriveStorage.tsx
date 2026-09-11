import { useEffect, useState } from 'react';
import { chooseDriveFolder, forgetDriveFolder, isGoogleDriveConfigured, prepareGoogleDrive, readDriveFolder } from '../utils/googleDriveConnection.ts';
import '../styles/google-drive-storage.css';

export function GoogleDriveStorage() {
  const [folder, setFolder] = useState(readDriveFolder);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void prepareGoogleDrive().then(() => { if (active) setReady(true); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      if (!ready) { await prepareGoogleDrive(); setReady(true); return; }
      const selected = await chooseDriveFolder();
      if (selected) setFolder(selected);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not connect Google Drive.'); }
    finally { setBusy(false); }
  };
  return <section className="drive-storage" aria-labelledby="drive-storage-title">
    <div className="drive-storage-heading">
      <div><h2 id="drive-storage-title">Google Drive</h2><p>Keep your recordings in your own Drive.</p></div>
      <button type="button" className="drive-connect" disabled={busy || !isGoogleDriveConfigured() || (!ready && !error)} onClick={() => void connect()}>
        {busy ? 'Connecting…' : !ready ? (error ? 'Try again' : 'Loading…') : folder ? 'Change folder' : 'Connect Google Drive'}
      </button>
    </div>
    {folder && <div className="drive-storage-folder">
      <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`} target="_blank" rel="noreferrer">{folder.name} ↗</a>
      <button type="button" disabled={busy} onClick={() => { try { forgetDriveFolder(); setFolder(null); } catch { setError('Could not clear the saved folder. Please try again.'); } }}>Forget folder</button>
    </div>}
    <p className="drive-storage-note">Save from the recording panel. Your folder’s sharing settings stay the same.</p>
    {folder && <p className="drive-storage-note">Folder remembered on this browser. Google may ask you to sign in again when saving.</p>}
    {error && <p className="drive-storage-error" role="alert">{error}</p>}
  </section>;
}
