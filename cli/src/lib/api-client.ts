/**
 * API client for the CLI tool.
 *
 * Uses native Node.js fetch with Bearer token authentication.
 * Automatically refreshes expired tokens.
 */

import { loadToken, saveToken, loadConfig } from "./config.js";

let cachedToken: string | null = null;

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await loadToken();
  return cachedToken;
}

export function setTokenCache(token: string): void {
  cachedToken = token;
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

    const data = (await res.json()) as { token: string };
    if (!data.token) return false;

    await saveToken(data.token);
    setTokenCache(data.token);
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
  const token = await getToken();
  if (!token) {
    throw new Error("Not logged in. Run `passwd-sso login` first.");
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
