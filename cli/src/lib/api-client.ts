/**
 * API client for the CLI tool.
 *
 * Uses native Node.js fetch with Bearer token authentication.
 * Automatically refreshes expired tokens via OAuth 2.1 refresh_token grant.
 */

import { loadCredentials, saveCredentials, loadConfig } from "./config.js";
import { refreshTokenGrant } from "./oauth.js";

let cachedToken: string | null = null;
let cachedExpiresAt: number | null = null;
let cachedRefreshToken: string | null = null;
let cachedClientId: string | null = null;

export function setInsecure(enabled: boolean): void {
  if (enabled) {
    process.stderr.write(
      "WARNING: TLS certificate verification is disabled. Your credentials may be intercepted.\n",
    );
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}

export function getToken(): string | null {
  if (cachedToken) return cachedToken;
  const creds = loadCredentials();
  if (!creds) return null;
  cachedToken = creds.accessToken;
  cachedExpiresAt = new Date(creds.expiresAt).getTime();
  cachedRefreshToken = creds.refreshToken || null;
  cachedClientId = creds.clientId || null;
  return cachedToken;
}

export function setTokenCache(
  token: string,
  expiresAt?: string,
  refreshToken?: string,
  clientId?: string,
): void {
  cachedToken = token;
  if (expiresAt) {
    cachedExpiresAt = new Date(expiresAt).getTime();
  }
  if (refreshToken !== undefined) {
    cachedRefreshToken = refreshToken || null;
  }
  if (clientId !== undefined) {
    cachedClientId = clientId || null;
  }
}

export function clearTokenCache(): void {
  cachedToken = null;
  cachedExpiresAt = null;
  cachedRefreshToken = null;
  cachedClientId = null;
}

function getBaseUrl(): string {
  const config = loadConfig();
  if (!config.serverUrl) {
    throw new Error("Server URL not configured. Run `passwd-sso login` first.");
  }
  return config.serverUrl.replace(/\/$/, "");
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

const REFRESH_BUFFER_MS = 2 * 60 * 1000;

function isTokenExpiringSoon(): boolean {
  if (!cachedExpiresAt) return false;
  return Date.now() >= cachedExpiresAt - REFRESH_BUFFER_MS;
}

async function refreshToken(): Promise<boolean> {
  if (!cachedRefreshToken || !cachedClientId) return false;

  const baseUrl = getBaseUrl();
  try {
    const result = await refreshTokenGrant(baseUrl, cachedRefreshToken, cachedClientId);
    if (!result.accessToken) return false;

    const nextRefreshToken = result.refreshToken || cachedRefreshToken;
    const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();

    saveCredentials({
      accessToken: result.accessToken,
      refreshToken: nextRefreshToken,
      clientId: cachedClientId,
      expiresAt,
    });
    setTokenCache(result.accessToken, expiresAt, nextRefreshToken, cachedClientId);

    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  let token = getToken();
  if (!token) {
    throw new Error("Not logged in. Run `passwd-sso login` first.");
  }

  if (isTokenExpiringSoon()) {
    const refreshed = await refreshToken();
    if (refreshed) {
      token = getToken();
    }
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;
  const { method = "GET", body, headers = {} } = options;

  const fetchOpts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    fetchOpts.body = JSON.stringify(body);
  }

  let res = await fetch(url, fetchOpts);

  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      const newToken = getToken();
      fetchOpts.headers = {
        ...fetchOpts.headers as Record<string, string>,
        Authorization: `Bearer ${newToken}`,
      };
      res = await fetch(url, fetchOpts);
    }
  }

  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

// ─── Background Token Refresh Timer ─────────────────────────

const BG_REFRESH_INTERVAL_MS = 50 * 60 * 1000;

let bgRefreshTimer: ReturnType<typeof setInterval> | null = null;

export function startBackgroundRefresh(): void {
  stopBackgroundRefresh();
  // Skip timer entirely for manual --token login (no refresh token)
  if (!cachedRefreshToken) return;
  bgRefreshTimer = setInterval(() => {
    void refreshToken();
  }, BG_REFRESH_INTERVAL_MS);
  bgRefreshTimer.unref();
}

export function stopBackgroundRefresh(): void {
  if (bgRefreshTimer) {
    clearInterval(bgRefreshTimer);
    bgRefreshTimer = null;
  }
}
