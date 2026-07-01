import { useState, useRef, useCallback, useEffect } from 'react';

const GOOGLE_CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_PERMISSIONS_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
const DRIVE_UPLOAD_RESUME_STORAGE_PREFIX = 'livestream-studio:drive-upload-session:';
const DRIVE_UPLOAD_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

interface UploadProgress {
  [fileName: string]: number; // 0-100
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

export interface DriveShareLinkResult {
  folderId: string;
  webViewLink: string;
  permissionId?: string;
}

type FetchLike = typeof fetch;

export interface DriveUploadResumeState {
  uploadUri: string;
  fileName: string;
  fileSize: number;
  folderId?: string;
  updatedAt: number;
}

export type DriveUploadResumeStatus =
  | { status: 'resume'; offset: number }
  | { status: 'complete'; fileId: string }
  | { status: 'invalid' };

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

function isDriveFileId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,200}$/.test(value);
}

export function buildDriveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

function hashDriveUploadIdentity(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createDriveUploadResumeKey(fileName: string, fileSize: number, folderId?: string): string {
  const normalizedFileName = fileName.trim() || 'untitled';
  const normalizedFolderId = folderId?.trim() || 'root';
  return `${DRIVE_UPLOAD_RESUME_STORAGE_PREFIX}${hashDriveUploadIdentity(`${normalizedFolderId}\n${normalizedFileName}\n${fileSize}`)}`;
}

export function parseDriveUploadRangeEnd(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d+)$/i.exec(rangeHeader.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  return end;
}

export function getDriveUploadResumeOffset(rangeHeader: string | null): number {
  const end = parseDriveUploadRangeEnd(rangeHeader);
  return end === null ? 0 : end + 1;
}

export function isFreshDriveUploadResumeState(
  state: DriveUploadResumeState,
  nowMs = Date.now(),
  maxAgeMs = DRIVE_UPLOAD_RESUME_TTL_MS
): boolean {
  return (
    typeof state.uploadUri === 'string' &&
    /^https:\/\//i.test(state.uploadUri) &&
    typeof state.fileName === 'string' &&
    Number.isSafeInteger(state.fileSize) &&
    state.fileSize >= 0 &&
    Number.isFinite(state.updatedAt) &&
    nowMs - state.updatedAt >= 0 &&
    nowMs - state.updatedAt <= maxAgeMs
  );
}

export async function queryDriveResumableUploadStatus(
  uploadUri: string,
  accessToken: string,
  fileSize: number,
  fetchImpl: FetchLike = fetch
): Promise<DriveUploadResumeStatus> {
  if (!uploadUri || !accessToken || !Number.isSafeInteger(fileSize) || fileSize < 0) {
    return { status: 'invalid' };
  }

  const response = await fetchImpl(uploadUri, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Range': `bytes */${fileSize}`,
    },
  });

  if (response.status === 308) {
    return {
      status: 'resume',
      offset: Math.min(getDriveUploadResumeOffset(response.headers.get('Range')), fileSize),
    };
  }

  if (response.ok) {
    const data = await response.json().catch(() => null);
    if (typeof data?.id === 'string') {
      return { status: 'complete', fileId: data.id };
    }
  }

  return { status: 'invalid' };
}

function getBrowserSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readDriveUploadResumeState(
  key: string,
  expected: { fileName: string; fileSize: number; folderId?: string },
  nowMs = Date.now()
): DriveUploadResumeState | null {
  const storage = getBrowserSessionStorage();
  if (!storage) return null;

  try {
    const parsed = JSON.parse(storage.getItem(key) || 'null') as Partial<DriveUploadResumeState> | null;
    if (!parsed) return null;
    const state: DriveUploadResumeState = {
      uploadUri: typeof parsed.uploadUri === 'string' ? parsed.uploadUri : '',
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
      fileSize: typeof parsed.fileSize === 'number' ? parsed.fileSize : -1,
      ...(typeof parsed.folderId === 'string' ? { folderId: parsed.folderId } : {}),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
    if (
      state.fileName !== expected.fileName ||
      state.fileSize !== expected.fileSize ||
      (state.folderId || '') !== (expected.folderId || '') ||
      !isFreshDriveUploadResumeState(state, nowMs)
    ) {
      storage.removeItem(key);
      return null;
    }
    return state;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function writeDriveUploadResumeState(key: string, state: DriveUploadResumeState) {
  const storage = getBrowserSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage can be unavailable or full; uploads still proceed without resume.
  }
}

function clearDriveUploadResumeState(key: string) {
  const storage = getBrowserSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

export async function createDriveFolderShareLinkRequest(
  accessToken: string,
  folderId: string,
  fetchImpl: FetchLike = fetch
): Promise<DriveShareLinkResult | null> {
  if (!accessToken || !isDriveFileId(folderId)) return null;

  const permissionResponse = await fetchImpl(
    `${DRIVE_PERMISSIONS_URL}/${encodeURIComponent(folderId)}/permissions?supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'anyone',
        role: 'reader',
      }),
    }
  );

  if (!permissionResponse.ok && permissionResponse.status !== 409) {
    return null;
  }

  const permissionData = permissionResponse.ok ? await permissionResponse.json().catch(() => null) : null;
  const fileResponse = await fetchImpl(
    `${DRIVE_FILES_URL}/${encodeURIComponent(folderId)}?fields=webViewLink`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!fileResponse.ok) {
    return {
      folderId,
      webViewLink: buildDriveFolderUrl(folderId),
      ...(typeof permissionData?.id === 'string' ? { permissionId: permissionData.id } : {}),
    };
  }

  const fileData = await fileResponse.json().catch(() => null);
  return {
    folderId,
    webViewLink: typeof fileData?.webViewLink === 'string' ? fileData.webViewLink : buildDriveFolderUrl(folderId),
    ...(typeof permissionData?.id === 'string' ? { permissionId: permissionData.id } : {}),
  };
}

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
        const totalSize = blob.size;
        const resumeKey = createDriveUploadResumeKey(fileName, totalSize, folderId);
        const resumeStateBase = {
          fileName,
          fileSize: totalSize,
          ...(folderId ? { folderId } : {}),
        };
        let uploadUri = '';
        let offset = 0;

        const existingResumeState = readDriveUploadResumeState(resumeKey, resumeStateBase);
        if (existingResumeState) {
          const status = await queryDriveResumableUploadStatus(
            existingResumeState.uploadUri,
            accessTokenRef.current,
            totalSize
          ).catch((): DriveUploadResumeStatus => ({ status: 'invalid' }));

          if (status.status === 'complete') {
            clearDriveUploadResumeState(resumeKey);
            setUploadProgress((prev) => ({ ...prev, [fileName]: 100 }));
            return status.fileId;
          }

          if (status.status === 'resume') {
            uploadUri = existingResumeState.uploadUri;
            offset = status.offset;
            writeDriveUploadResumeState(resumeKey, {
              ...existingResumeState,
              updatedAt: Date.now(),
            });
            if (offset > 0 && totalSize > 0) {
              const progress = Math.min(99, Math.round((offset / totalSize) * 100));
              setUploadProgress((prev) => ({ ...prev, [fileName]: progress }));
            }
          } else {
            clearDriveUploadResumeState(resumeKey);
          }
        }

        if (!uploadUri) {
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
                'X-Upload-Content-Length': totalSize.toString(),
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

          uploadUri = initResponse.headers.get('Location') || '';
          if (!uploadUri) {
            console.error('No upload URI in response');
            setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
            return null;
          }

          writeDriveUploadResumeState(resumeKey, {
            uploadUri,
            ...resumeStateBase,
            updatedAt: Date.now(),
          });
        }

        // Step 2: Upload the file in chunks using resumable upload
        while (offset < totalSize) {
          const end = Math.min(offset + DRIVE_UPLOAD_CHUNK_SIZE, totalSize);
          const chunk = blob.slice(offset, end);
          const isLastChunk = end === totalSize;

          const uploadResponse = await fetch(uploadUri, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessTokenRef.current}`,
              'Content-Length': chunk.size.toString(),
              'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
            },
            body: chunk,
          });

          if (uploadResponse.status === 308) {
            const acknowledgedOffset = getDriveUploadResumeOffset(uploadResponse.headers.get('Range'));
            offset = Math.min(acknowledgedOffset > 0 ? acknowledgedOffset : end, totalSize);
            writeDriveUploadResumeState(resumeKey, {
              uploadUri,
              ...resumeStateBase,
              updatedAt: Date.now(),
            });
            const progress = totalSize > 0 ? Math.round((offset / totalSize) * 100) : 100;
            setUploadProgress((prev) => ({ ...prev, [fileName]: progress }));
            continue;
          }

          if (!uploadResponse.ok) {
            const error = await uploadResponse.text();
            console.error(isLastChunk ? 'Failed to complete upload:' : 'Chunk upload failed:', error);
            setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
            return null;
          }

          if (isLastChunk) {
            const data = await uploadResponse.json();
            if (typeof data?.id !== 'string') throw new Error('Invalid response from Google Drive API');
            clearDriveUploadResumeState(resumeKey);
            setUploadProgress((prev) => ({ ...prev, [fileName]: 100 }));
            console.log(`Uploaded ${fileName} to Google Drive (${data.id})`);
            return data.id;
          }

          offset = end;
          const progress = Math.round((offset / totalSize) * 100);
          setUploadProgress((prev) => ({ ...prev, [fileName]: progress }));
        }

        if (totalSize === 0) {
          clearDriveUploadResumeState(resumeKey);
          setUploadProgress((prev) => ({ ...prev, [fileName]: 100 }));
          return null;
        }

        const finalStatus = await queryDriveResumableUploadStatus(
          uploadUri,
          accessTokenRef.current,
          totalSize
        ).catch((): DriveUploadResumeStatus => ({ status: 'invalid' }));
        if (finalStatus.status === 'complete') {
          clearDriveUploadResumeState(resumeKey);
          setUploadProgress((prev) => ({ ...prev, [fileName]: 100 }));
          return finalStatus.fileId;
        }

        setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
        return null;
      } catch (err) {
        console.error(`Error uploading ${fileName}:`, err);
        setUploadProgress((prev) => ({ ...prev, [fileName]: -1 }));
        return null;
      }
    },
    [ensureFreshToken]
  );

  const createShareLink = useCallback(async (folderId: string): Promise<DriveShareLinkResult | null> => {
    const ok = await ensureFreshToken();
    if (!ok || !accessTokenRef.current) {
      console.error('Not authorized');
      return null;
    }

    try {
      const result = await createDriveFolderShareLinkRequest(accessTokenRef.current, folderId);
      if (!result) {
        console.error('Failed to create Google Drive share link');
        return null;
      }
      return result;
    } catch (err) {
      console.error('Error creating Google Drive share link:', err);
      return null;
    }
  }, [ensureFreshToken]);

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
    createShareLink,
    uploadProgress,
    isUploading,
    isAuthorized,
  };
}
