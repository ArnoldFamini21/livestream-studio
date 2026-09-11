export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_KEY = 'livestream-studio:drive-folder:v1';
export interface DriveFolder { id: string; name: string }
interface TokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string }
interface OAuthApi {
  initTokenClient(config: {
    client_id: string; scope: string; include_granted_scopes: boolean;
    callback(response: TokenResponse): void;
    error_callback(error: { type?: string }): void;
  }): { requestAccessToken(options: { prompt: string }): void };
}
interface PickerView {
  setIncludeFolders(value: boolean): PickerView;
  setSelectFolderEnabled(value: boolean): PickerView;
  setMimeTypes(value: string): PickerView;
}
interface Picker { setVisible(value: boolean): void; dispose(): void }
interface PickerBuilder {
  setOAuthToken(value: string): PickerBuilder;
  setDeveloperKey(value: string): PickerBuilder;
  setAppId(value: string): PickerBuilder;
  setOrigin(value: string): PickerBuilder;
  setTitle(value: string): PickerBuilder;
  addView(view: PickerView): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: unknown[] }) => void): PickerBuilder;
  build(): Picker;
}
interface GoogleWindow extends Window {
  google?: {
    accounts?: { oauth2: OAuthApi };
    picker?: { DocsView: new () => PickerView; PickerBuilder: new () => PickerBuilder };
  };
  gapi?: { load(name: string, options: { callback(): void; onerror(): void; timeout: number; ontimeout(): void }): void };
}
const config = {
  clientId: import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
  apiKey: import.meta.env?.VITE_GOOGLE_PICKER_API_KEY || '',
  appId: import.meta.env?.VITE_GOOGLE_APP_ID || '',
};
export function isGoogleDriveConfigured(): boolean {
  return /^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(config.clientId)
    && /^\d+$/.test(config.appId) && Boolean(config.apiKey);
}
export function normalizeDriveFolder(value: unknown): DriveFolder | null {
  if (!value || typeof value !== 'object') return null;
  const folder = value as Partial<DriveFolder>;
  return typeof folder.id === 'string' && /^[\w-]{8,200}$/.test(folder.id)
    && typeof folder.name === 'string' && folder.name.trim()
    ? { id: folder.id, name: folder.name.trim().slice(0,255) } : null;
}
export function readDriveFolder(): DriveFolder | null {
  try { return normalizeDriveFolder(JSON.parse(localStorage.getItem(FOLDER_KEY) || 'null')); }
  catch { return null; }
}
function saveDriveFolder(folder: DriveFolder) {
  try { localStorage.setItem(FOLDER_KEY, JSON.stringify(folder)); }
  catch { throw new Error('Allow site storage to remember your recording folder.'); }
}
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  const existing = scripts.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => fail(), 15000);
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('Google could not load. Check your connection and try again.')); };
    script.src = src; script.async = true;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  scripts.set(src, promise);
  void promise.catch(() => scripts.delete(src));
  return promise;
}
export async function prepareGoogleDrive(): Promise<void> {
  if (!isGoogleDriveConfigured()) throw new Error('Google Drive is not configured yet.');
  if (!(window as GoogleWindow).google?.accounts?.oauth2) await loadScript('https://accounts.google.com/gsi/client');
  if (!(window as GoogleWindow).google?.accounts?.oauth2) throw new Error('Google sign-in could not load. Please reload and try again.');
}
// Tokens stay in memory, never in localStorage, URLs, or the recording catalog.
export function createDriveAuthorizer(getOAuth: () => OAuthApi | undefined, clientId: string, timeoutMs = 90000) {
  let token: string | null = null;
  let expiresAt = 0;
  let pending: Promise<string> | null = null;
  let generation = 0;
  return {
    clear() { token = null; expiresAt = 0; generation += 1; },
    authorize(): Promise<string> {
      if (token && Date.now() < expiresAt - 300000) return Promise.resolve(token);
      if (pending) return pending;
      const oauth = getOAuth();
      if (!oauth) return Promise.reject(new Error('Google sign-in is loading. Please try again.'));
      const currentGeneration = generation;
      const request = new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Please try again.')), timeoutMs);
        function finish(error?: Error, response?: TokenResponse) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (generation !== currentGeneration) return reject(new Error('Google connection was cleared. Please try again.'));
          if (error) return reject(error);
          const ttl = Number(response?.expires_in);
          if (!response?.access_token || !response.scope?.split(/\s+/).includes(DRIVE_FILE_SCOPE) || !Number.isFinite(ttl) || ttl <= 0) {
            return reject(new Error('Allow access to the Drive files you select to save recordings.'));
          }
          token = response.access_token; expiresAt = Date.now() + ttl * 1000; resolve(token);
        }
        try {
          oauth.initTokenClient({
            client_id: clientId, scope: DRIVE_FILE_SCOPE, include_granted_scopes: false,
            callback: response => finish(response.error ? new Error('Google access was not granted. Please try again.') : undefined, response),
            error_callback: error => finish(new Error(error.type === 'popup_closed'
              ? 'Google sign-in was closed. Try again when you are ready.'
              : 'Allow the Google sign-in popup for this site, then try again.')),
          }).requestAccessToken({ prompt: '' });
        } catch { finish(new Error('Google sign-in could not open. Please try again.')); }
      });
      pending = request;
      void request.then(() => { pending = null; }, () => { pending = null; });
      return request;
    },
  };
}
const authorizer = createDriveAuthorizer(() => (window as GoogleWindow).google?.accounts?.oauth2, config.clientId);
export function authorizeGoogleDrive(): Promise<string> { return authorizer.authorize(); }
export function forgetDriveFolder(): void {
  localStorage.removeItem(FOLDER_KEY);
  authorizer.clear();
}
export async function validateDriveFolder(token: string, id: string, fetchImpl: typeof fetch = fetch): Promise<DriveFolder> {
  if (!token || !/^[\w-]{8,200}$/.test(id)) throw new Error('Choose a Google Drive folder first.');
  const response = await fetchImpl(`${FILES_URL}/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Reconnect Google Drive and select a folder this account can edit.');
  const data = await response.json();
  const folder = normalizeDriveFolder(data);
  if (!folder || folder.id !== id || data.mimeType !== FOLDER_TYPE || data.trashed || data.capabilities?.canAddChildren !== true) {
    throw new Error('Choose a folder where you can add recordings.');
  }
  return folder;
}
export async function chooseDriveFolder(): Promise<DriveFolder | null> {
  // Start OAuth directly from the button gesture; the script is preloaded by the UI.
  const token = await authorizeGoogleDrive();
  const win = window as GoogleWindow;
  if (!win.gapi) await loadScript('https://apis.google.com/js/api.js');
  if (!win.google?.picker) await new Promise<void>((resolve, reject) => {
    if (!win.gapi) return reject(new Error('Google folder picker could not load.'));
    win.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google folder picker could not load.')), timeout: 15000, ontimeout: () => reject(new Error('Google folder picker timed out.')) });
  });
  const api = win.google?.picker;
  if (!api) throw new Error('Google folder picker could not load.');
  const selected = await new Promise<DriveFolder | null>((resolve, reject) => {
    const view = new api.DocsView().setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_TYPE);
    const picker = new api.PickerBuilder().setOAuthToken(token).setDeveloperKey(config.apiKey)
      .setAppId(config.appId).setOrigin(window.location.origin).setTitle('Choose your recording folder').addView(view)
      .setCallback(data => {
        if (data.action === 'cancel') { picker.dispose(); resolve(null); }
        if (data.action === 'picked') {
          picker.dispose();
          const folder = normalizeDriveFolder(data.docs?.[0]);
          if (!folder) reject(new Error('Please select a folder.')); else resolve(folder);
        }
      }).build();
    picker.setVisible(true);
  });
  if (!selected) return null;
  const folder = await validateDriveFolder(token, selected.id);
  saveDriveFolder(folder);
  return folder;
}
export async function getDriveUploadDestination(): Promise<DriveFolder> {
  const saved = readDriveFolder();
  if (!saved) {
    const chosen = await chooseDriveFolder();
    if (!chosen) throw new Error('Choose a recording folder to save to Google Drive.');
    return chosen;
  }
  return validateDriveFolder(await authorizeGoogleDrive(), saved.id);
}
export async function createDriveRecordingFolder(token: string, parent: DriveFolder, name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!token || !normalizeDriveFolder(parent) || !name.trim()) throw new Error('Choose a recording folder first.');
  const response = await fetchImpl(`${FILES_URL}?supportsAllDrives=true&fields=id`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_TYPE, parents: [parent.id] }), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Could not create the recording folder in Google Drive.');
  const data = await response.json();
  if (typeof data.id !== 'string' || !/^[\w-]{8,200}$/.test(data.id)) throw new Error('Google Drive did not return a recording folder.');
  return data.id;
}
