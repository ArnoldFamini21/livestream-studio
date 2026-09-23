import type {
  AccountAuthResponse,
  AccountCapabilitiesResponse,
  AccountChangePasswordRequest,
  AccountChangePasswordResponse,
  AccountLoginRequest,
  AccountLogoutResponse,
  AccountPasswordResetConfirmRequest,
  AccountPasswordResetRequestResponse,
  AccountRegisterRequest,
  AccountRevokeSessionsResponse,
  AccountSessionResponse,
  AccountSessionsResponse,
} from '@studio/shared';
import { postJson, getJson, requestJson } from './apiClient.ts';

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

export function accountHeaders(): Headers {
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

export function fetchAccountCapabilities(): Promise<AccountCapabilitiesResponse> {
  return getJson<AccountCapabilitiesResponse>('/api/auth/capabilities', { credentials: 'include' });
}

export function changeAccountPassword(input: AccountChangePasswordRequest): Promise<AccountChangePasswordResponse> {
  return postJson<AccountChangePasswordResponse>('/api/auth/password', input, {
    credentials: 'include',
    headers: accountHeaders(),
  });
}

export function fetchAccountSessions(): Promise<AccountSessionsResponse> {
  return getJson<AccountSessionsResponse>('/api/auth/sessions', {
    credentials: 'include',
    headers: accountHeaders(),
  });
}

export async function revokeAccountSession(sessionId: string): Promise<{ ok: true; revokedCurrent: boolean }> {
  const result = await requestJson<{ ok: true; revokedCurrent: boolean }>(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: accountHeaders(),
  });
  if (result.revokedCurrent) clearAccountSessionToken();
  return result;
}

export function revokeOtherAccountSessions(): Promise<AccountRevokeSessionsResponse> {
  return postJson<AccountRevokeSessionsResponse>('/api/auth/sessions/revoke-others', {}, {
    credentials: 'include',
    headers: accountHeaders(),
  });
}

export function requestPasswordReset(email: string): Promise<AccountPasswordResetRequestResponse> {
  return postJson<AccountPasswordResetRequestResponse>('/api/auth/password-reset/request', { email }, {
    credentials: 'include',
  });
}

export async function confirmPasswordReset(input: AccountPasswordResetConfirmRequest): Promise<AccountAuthResponse> {
  return storeAuthResponse(await postJson<AccountAuthResponse>('/api/auth/password-reset/confirm', input, {
    credentials: 'include',
  }));
}

/** Read the reset token from a `#token=` fragment (never sent to servers or in Referer). */
export function readPasswordResetToken(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = (params.get('token') || '').trim();
  return isValidAccountSessionToken(token) ? token : '';
}
