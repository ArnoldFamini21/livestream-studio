import { useState, useRef, useCallback, useEffect } from 'react';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

interface UploadProgress {
  [fileName: string]: number; // 0-100
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; expires_in?: number; error?: string }) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

// Google OAuth access tokens default to ~1 hour. Treat them as stale a bit early
// so we proactively re-auth before a long upload runs out of token mid-flight.
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export function useGoogleDriveUpload() {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({});

  const accessTokenRef = useRef<string | null>(null);
  const accessTokenExpiresAtRef = useRef<number>(0);
  const tokenClientRef = useRef<TokenClient | null>(null);
  const gisLoadedRef = useRef<boolean>(false);

  function isTokenFresh(): boolean {
    return Boolean(accessTokenRef.current) && Date.now() < accessTokenExpiresAtRef.current - TOKEN_SAFETY_MARGIN_MS;
  }

  // Load Google Identity Services script dynamically
  const loadGisScript = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (gisLoadedRef.current && window.google?.accounts?.oauth2) {
        resolve();
        return;
      }

      // Check if script is already in the DOM
      const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
      if (existing) {
        // Script tag exists, wait for it to load
        if (window.google?.accounts?.oauth2) {
          gisLoadedRef.current = true;
          resolve();
          return;
        }
        existing.addEventListener('load', () => {
          gisLoadedRef.current = true;
          resolve();
        });
        existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        gisLoadedRef.current = true;
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(script);
    });
  }, []);

  // Resolver for the in-flight authorize() call. The token client is created once
  // and reused; each authorize() swaps in a new resolver via this ref so we don't
  // re-initialize the underlying client and leak the previous one.
  const pendingResolveRef = useRef<((authorized: boolean) => void) | null>(null);

  const handleTokenResponse = useCallback((response: { access_token?: string; expires_in?: number; error?: string }) => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;

    if (response.error) {
      console.error('OAuth2 error:', response.error);
      setIsAuthorized(false);
      accessTokenRef.current = null;
      accessTokenExpiresAtRef.current = 0;
      resolve?.(false);
      return;
    }
    if (response.access_token) {
      accessTokenRef.current = response.access_token;
      // expires_in is in seconds; default to 1 hour if absent.
      const ttlMs = (response.expires_in ?? 3600) * 1000;
      accessTokenExpiresAtRef.current = Date.now() + ttlMs;
      setIsAuthorized(true);
      console.log('Google Drive authorized');
      resolve?.(true);
      return;
    }
    resolve?.(false);
  }, []);

  const initTokenClient = useCallback(() => {
    if (!window.google?.accounts?.oauth2) {
      console.error('Google Identity Services not loaded');
      return null;
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: handleTokenResponse,
    });
    tokenClientRef.current = client;
    return client;
  }, [handleTokenResponse]);

  const authorize = useCallback(async (): Promise<boolean> => {
    try {
      await loadGisScript();

      const client = tokenClientRef.current ?? initTokenClient();
      if (!client) {
        console.error('Failed to initialize token client');
        return false;
      }

      return new Promise((resolve) => {
        pendingResolveRef.current = resolve;
        client.requestAccessToken({ prompt: '' });
      });
    } catch (err) {
      console.error('Authorization failed:', err);
      return false;
    }
  }, [loadGisScript, initTokenClient]);

  // Ensure we have a fresh token (or trigger re-auth) before kicking off a long upload.
  const ensureFreshToken = useCallback(async (): Promise<boolean> => {
    if (isTokenFresh()) return true;
    return authorize();
  }, [authorize]);

  const createFolder = useCallback(async (name: string): Promise<string | null> => {
    const ok = await ensureFreshToken();
    if (!ok || !accessTokenRef.current) {
      console.error('Not authorized');
      return null;
    }

    try {
      const metadata = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
      };

      const response = await fetch(DRIVE_FILES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessTokenRef.current}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Failed to create folder:', error);
        return null;
      }

      const data = await response.json();
      if (typeof data?.id !== 'string') throw new Error('Invalid response from Google Drive API');
      console.log(`Created Google Drive folder: ${name} (${data.id})`);
      return data.id;
    } catch (err) {
      console.error('Error creating folder:', err);
      return null;
    }
  }, [ensureFreshToken]);

  const uploadFile = useCallback(
    async (blob: Blob, fileName: string, folderId?: string): Promise<string | null> => {
      // Refresh the token now if it's stale; otherwise a long upload could die mid-stream.
      const ok = await ensureFreshToken();
      if (!ok || !accessTokenRef.current) {
        console.error('Not authorized');
        return null;
      }

      setUploadProgress((prev) => ({ ...prev, [fileName]: 0 }));

      try {
        // Step 1: Initiate resumable upload session
        const metadata: Record<string, unknown> = { name: fileName };
        if (folderId) {
          metadata.parents = [folderId];
        }

        const initResponse = await fetch(
          `${DRIVE_UPLOAD_URL}?uploadType=resumable`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessTokenRef.current}`,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': blob.type || 'application/octet-stream',
              'X-Upload-Content-Length': blob.size.toString(),
            },
            body: JSON.stringify(metadata),
          }
        );

        if (!initResponse.ok) {
          const error = await initResponse.text();
          console.error('Failed to initiate upload:', error);
          setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
          return null;
        }

        const uploadUri = initResponse.headers.get('Location');
        if (!uploadUri) {
          console.error('No upload URI in response');
          setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
          return null;
        }

        // Step 2: Upload the file in chunks using resumable upload
        const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks
        const totalSize = blob.size;
        let offset = 0;

        while (offset < totalSize) {
          const end = Math.min(offset + CHUNK_SIZE, totalSize);
          const chunk = blob.slice(offset, end);
          const isLastChunk = end === totalSize;

          const uploadResponse = await fetch(uploadUri, {
            method: 'PUT',
            headers: {
              'Content-Length': chunk.size.toString(),
              'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
            },
            body: chunk,
          });

          if (isLastChunk) {
            if (!uploadResponse.ok) {
              const error = await uploadResponse.text();
              console.error('Failed to complete upload:', error);
              setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
              return null;
            }

            const data = await uploadResponse.json();
            if (typeof data?.id !== 'string') throw new Error('Invalid response from Google Drive API');
            setUploadProgress((prev) => ({ ...prev, [fileName]: 100 }));
            console.log(`Uploaded ${fileName} to Google Drive (${data.id})`);
            return data.id;
          }

          // For non-last chunks, 308 Resume Incomplete is expected
          if (uploadResponse.status !== 308 && !uploadResponse.ok) {
            const error = await uploadResponse.text();
            console.error('Chunk upload failed:', error);
            setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
            return null;
          }

          offset = end;
          const progress = Math.round((offset / totalSize) * 100);
          setUploadProgress((prev) => ({ ...prev, [fileName]: progress }));
        }

        // Should not reach here, but just in case for zero-size blobs
        setUploadProgress((prev) => ({ ...prev, [fileName]: 100 }));
        return null;
      } catch (err) {
        console.error(`Error uploading ${fileName}:`, err);
        setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
        return null;
      }
    },
    [ensureFreshToken]
  );

  // Track overall uploading state based on progress
  useEffect(() => {
    const values = Object.values(uploadProgress);
    if (values.length === 0) {
      setIsUploading(false);
      return;
    }
    const hasActive = values.some((v) => v >= 0 && v < 100);
    setIsUploading(hasActive);
  }, [uploadProgress]);

  return {
    authorize,
    uploadFile,
    createFolder,
    uploadProgress,
    isUploading,
    isAuthorized,
  };
}
