/**
 * Google Identity Services token client shared by Drive and YouTube.
 * Access tokens stay in memory only — never in localStorage, URLs, or catalogs.
 */
export interface GoogleTokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string }
export interface GoogleOAuthApi {
  initTokenClient(config: {
    client_id: string; scope: string; include_granted_scopes: boolean;
    callback(response: GoogleTokenResponse): void;
    error_callback(error: { type?: string }): void;
  }): { requestAccessToken(options: { prompt: string }): void };
}

export interface GoogleTokenAuthorizerOptions {
  getOAuth: () => GoogleOAuthApi | undefined;
  clientId: string;
  /** Space-separated scopes; every one must be granted. */
  scope: string;
  /** Shown when the account declines one of the required scopes. */
  missingScopeMessage: string;
  timeoutMs?: number;
}

export interface GoogleTokenAuthorizer {
  clear(): void;
  authorize(): Promise<string>;
}

export function isGoogleOAuthClientId(value: string): boolean {
  return /^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(value);
}

export function createGoogleTokenAuthorizer(options: GoogleTokenAuthorizerOptions): GoogleTokenAuthorizer {
  const timeoutMs = options.timeoutMs ?? 90000;
  const requiredScopes = options.scope.split(/\s+/).filter(Boolean);
  let token: string | null = null;
  let expiresAt = 0;
  let pending: Promise<string> | null = null;
  let generation = 0;
  return {
    clear() { token = null; expiresAt = 0; generation += 1; },
    authorize(): Promise<string> {
      if (token && Date.now() < expiresAt - 300000) return Promise.resolve(token);
      if (pending) return pending;
      const oauth = options.getOAuth();
      if (!oauth) return Promise.reject(new Error('Google sign-in is loading. Please try again.'));
      const currentGeneration = generation;
      const request = new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Please try again.')), timeoutMs);
        function finish(error?: Error, response?: GoogleTokenResponse) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (generation !== currentGeneration) return reject(new Error('Google connection was cleared. Please try again.'));
          if (error) return reject(error);
          const ttl = Number(response?.expires_in);
          const granted = response?.scope?.split(/\s+/) || [];
          if (!response?.access_token || requiredScopes.some((scope) => !granted.includes(scope)) || !Number.isFinite(ttl) || ttl <= 0) {
            return reject(new Error(options.missingScopeMessage));
          }
          token = response.access_token; expiresAt = Date.now() + ttl * 1000; resolve(token);
        }
        try {
          oauth.initTokenClient({
            client_id: options.clientId, scope: options.scope, include_granted_scopes: false,
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

const scripts = new Map<string, Promise<void>>();
export function loadGoogleScript(src: string): Promise<void> {
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

interface GoogleIdentityWindow extends Window {
  google?: { accounts?: { oauth2: GoogleOAuthApi } };
}

export function getGoogleOAuthApi(): GoogleOAuthApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as GoogleIdentityWindow).google?.accounts?.oauth2;
}

export async function prepareGoogleIdentity(): Promise<void> {
  if (!getGoogleOAuthApi()) await loadGoogleScript('https://accounts.google.com/gsi/client');
  if (!getGoogleOAuthApi()) throw new Error('Google sign-in could not load. Please reload and try again.');
}
