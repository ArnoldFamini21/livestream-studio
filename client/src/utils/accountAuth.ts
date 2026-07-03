import type {
  AccountAuthResponse,
  AccountLoginRequest,
  AccountLogoutResponse,
  AccountRegisterRequest,
  AccountSessionResponse,
} from '@studio/shared';
import { postJson, getJson } from './apiClient.ts';

export const ACCOUNT_SESSION_STORAGE_KEY = 'livestream-studio:account-session-token';

function getLocalItem(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function setLocalItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The HttpOnly cookie path can still keep the account session alive.
  }
}

function removeLocalItem(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore restricted storage modes.
  }
}

export function isValidAccountSessionToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function readAccountSessionToken(): string {
  const token = getLocalItem(ACCOUNT_SESSION_STORAGE_KEY).trim();
  return isValidAccountSessionToken(token) ? token : '';
}

export function persistAccountSessionToken(token: string) {
  if (!isValidAccountSessionToken(token)) return;
  setLocalItem(ACCOUNT_SESSION_STORAGE_KEY, token);
}

export function clearAccountSessionToken() {
  removeLocalItem(ACCOUNT_SESSION_STORAGE_KEY);
}

function accountHeaders(): Headers {
  const headers = new Headers();
  const token = readAccountSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

function storeAuthResponse(response: AccountAuthResponse): AccountAuthResponse {
  persistAccountSessionToken(response.session.token);
  return response;
}

export async function registerAccount(input: AccountRegisterRequest): Promise<AccountAuthResponse> {
  return storeAuthResponse(await postJson<AccountAuthResponse>('/api/auth/register', input, {
    credentials: 'include',
  }));
}

export async function loginAccount(input: AccountLoginRequest): Promise<AccountAuthResponse> {
  return storeAuthResponse(await postJson<AccountAuthResponse>('/api/auth/login', input, {
    credentials: 'include',
  }));
}

export function fetchAccountSession(): Promise<AccountSessionResponse> {
  return getJson<AccountSessionResponse>('/api/auth/session', {
    credentials: 'include',
    headers: accountHeaders(),
  });
}

export async function logoutAccount(): Promise<AccountLogoutResponse> {
  try {
    return await postJson<AccountLogoutResponse>('/api/auth/logout', {}, {
      credentials: 'include',
      headers: accountHeaders(),
    });
  } finally {
    clearAccountSessionToken();
  }
}
