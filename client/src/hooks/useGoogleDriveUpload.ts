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
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

export function useGoogleDriveUpload() {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({});

  const accessTokenRef = useRef<string | null>(null);
  const tokenClientRef = useRef<TokenClient | null>(null);
  const gisLoadedRef = useRef<boolean>(false);

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

  const initTokenClient = useCallback(() => {
    if (!window.google?.accounts?.oauth2) {
      console.error('Google Identity Services not loaded');
      return null;
    }

    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          console.error('OAuth2 error:', response.error);
          setIsAuthorized(false);
          return;
        }
        if (response.access_token) {
          accessTokenRef.current = response.access_token;
          setIsAuthorized(true);
          console.log('Google Drive authorized');
        }
      },
    });

    tokenClientRef.current = client;
    return client;
  }, []);

  const authorize = useCallback(async (): Promise<boolean> => {
    try {
      await loadGisScript();

      let client = tokenClientRef.current;
      if (!client) {
        client = initTokenClient();
      }

      if (!client) {
        console.error('Failed to initialize token client');
        return false;
      }

      return new Promise((resolve) => {
        // Override callback for this specific authorization request
        const originalClient = window.google!.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: (response) => {
            if (response.error) {
              console.error('OAuth2 error:', response.error);
              setIsAuthorized(false);
              resolve(false);
              return;
            }
            if (response.access_token) {
              accessTokenRef.current = response.access_token;
              setIsAuthorized(true);
              resolve(true);
            }
          },
        });

        tokenClientRef.current = originalClient;
        originalClient.requestAccessToken({ prompt: '' });
      });
    } catch (err) {
      console.error('Authorization failed:', err);
      return false;
    }
  }, [loadGisScript, initTokenClient]);

  const createFolder = useCallback(async (name: string): Promise<string | null> => {
    if (!accessTokenRef.current) {
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
  }, []);

  const uploadFile = useCallback(
    async (blob: Blob, fileName: string, folderId?: string): Promise<string | null> => {
      if (!accessTokenRef.current) {
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
    []
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
