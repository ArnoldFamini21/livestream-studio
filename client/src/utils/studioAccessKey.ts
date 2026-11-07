import { accountHeaders } from './accountAuth.ts';
import { ApiRequestError } from './apiClient.ts';

/**
 * The owner's studio access key. Once the server sets STUDIO_CREATE_SECRET (or
 * STUDIO_OWNER_EMAILS), only the owner can create studios; on the owner's own
 * browsers the key is remembered here and sent with every create request.
 */

export const STUDIO_ACCESS_KEY_STORAGE_KEY = 'studioAccessKey';
export const STUDIO_ACCESS_KEY_HEADER = 'X-Studio-Access-Key';
export const STUDIO_ACCESS_REQUIRED_CODE = 'STUDIO_ACCESS_REQUIRED';
const MAX_ACCESS_KEY_LENGTH = 512;

export interface StudioAccessKeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): StudioAccessKeyStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeStudioAccessKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, MAX_ACCESS_KEY_LENGTH);
}

export function getStoredStudioAccessKey(storage: StudioAccessKeyStorage | null = browserStorage()): string {
  try {
    return normalizeStudioAccessKey(storage?.getItem(STUDIO_ACCESS_KEY_STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

/** Saves (or, when empty, forgets) the key; returns what was saved. */
export function saveStudioAccessKey(value: string, storage: StudioAccessKeyStorage | null = browserStorage()): string {
  const key = normalizeStudioAccessKey(value);
  try {
    if (key) storage?.setItem(STUDIO_ACCESS_KEY_STORAGE_KEY, key);
    else storage?.removeItem(STUDIO_ACCESS_KEY_STORAGE_KEY);
  } catch {
    /* storage is optional: the key is still sent for this request */
  }
  return key;
}

/** Headers for creating a studio: the owner's account session and, when kept, the access key. */
export function buildStudioCreateHeaders(accessKey: string = getStoredStudioAccessKey()): Headers {
  const headers = accountHeaders();
  const key = normalizeStudioAccessKey(accessKey);
  if (key) headers.set(STUDIO_ACCESS_KEY_HEADER, key);
  return headers;
}

/** Whether the server refused to create a studio because the owner's key or account is missing. */
export function isStudioAccessRequiredError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.status !== 401 && error.status !== 403) return false;
  try {
    const body = JSON.parse(error.responseText || '{}') as { code?: unknown };
    return body.code === STUDIO_ACCESS_REQUIRED_CODE;
  } catch {
    return false;
  }
}
