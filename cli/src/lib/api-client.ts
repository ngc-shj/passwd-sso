/**
 * API client for the CLI tool.
 *
 * Uses native Node.js fetch with Bearer token authentication.
 * Automatically refreshes expired tokens.
 */

import { loadToken, saveToken, loadConfig, saveConfig } from "./config.js";

let cachedToken: string | null = null;
let cachedExpiresAt: number | null = null;

export function setInsecure(enabled: boolean): void {
  if (enabled) {
    // Suppress the NODE_TLS warning before setting the env var
    const origEmit = process.emit.bind(process);
    process.emit = function (event: string, ...args: unknown[]) {
      if (event === "warning" && (args[0] as { name?: string })?.name === "Warning") {
        return false;
      }
      return origEmit(event, ...args);
    } as typeof process.emit;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await loadToken();
  return cachedToken;
}

export function setTokenCache(token: string, expiresAt?: string): void {
  cachedToken = token;
  if (expiresAt) {
    cachedExpiresAt = new Date(expiresAt).getTime();
  }
}

export function clearTokenCache(): void {
  cachedToken = null;
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

/** Refresh buffer: refresh 2 minutes before expiry */
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

function isTokenExpiringSoon(): boolean {
  if (!cachedExpiresAt) {
    // Load from config if not cached
    const config = loadConfig();
    if (config.tokenExpiresAt) {
      cachedExpiresAt = new Date(config.tokenExpiresAt).getTime();
    }
  }
  if (!cachedExpiresAt) return false;
  return Date.now() >= cachedExpiresAt - REFRESH_BUFFER_MS;
}

async function refreshToken(): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  const baseUrl = getBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/extension/token/refresh`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return false;

    const data = (await res.json()) as { token: string; expiresAt: string };
    if (!data.token) return false;

    await saveToken(data.token);
    setTokenCache(data.token, data.expiresAt);

    // Persist expiresAt in config
    const config = loadConfig();
    config.tokenExpiresAt = data.expiresAt;
    saveConfig(config);

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
  let token = await getToken();
  if (!token) {
    throw new Error("Not logged in. Run `passwd-sso login` first.");
  }

  // Proactively refresh if token is expiring soon
  if (isTokenExpiringSoon()) {
    const refreshed = await refreshToken();
    if (refreshed) {
      token = await getToken();
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

  // Auto-refresh on 401
  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      const newToken = await getToken();
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

/** Interval: refresh every 10 minutes (well within 15-min TTL) */
const BG_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

let bgRefreshTimer: ReturnType<typeof setInterval> | null = null;

export function startBackgroundRefresh(): void {
  stopBackgroundRefresh();
  bgRefreshTimer = setInterval(() => {
    void refreshToken();
  }, BG_REFRESH_INTERVAL_MS);
  // Don't keep the process alive just for the timer
  bgRefreshTimer.unref();
}

export function stopBackgroundRefresh(): void {
  if (bgRefreshTimer) {
    clearInterval(bgRefreshTimer);
    bgRefreshTimer = null;
  }
}
