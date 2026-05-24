/**
 * Extracted token lifecycle helpers for testability (Round 2 T23).
 *
 * These functions are consumed by index.ts and can be imported directly
 * in unit tests without instantiating the full service worker.
 */

import { EXT_API_PATH } from "../lib/api-paths";
import { getSettings } from "../lib/storage";
import { DpopSignError, swFetchAuthenticated } from "./dpop-fetch";

// ── Token refresh ──────────────────────────────────────────────

export interface TokenRefreshCallbacks {
  getCurrentToken(): string | null;
  getTokenExpiresAt(): number | null;
  setToken(token: string, expiresAt: number): void;
  clearToken(): void;
  scheduleRefreshAlarm(expiresAt: number): void;
  createTtlAlarm(when: number): void;
}

export async function attemptTokenRefreshWith(
  callbacks: TokenRefreshCallbacks,
): Promise<void> {
  const token = callbacks.getCurrentToken();
  const tokenExpiresAt = callbacks.getTokenExpiresAt();
  if (!token || !tokenExpiresAt) return;
  if (Date.now() >= tokenExpiresAt) return;

  try {
    const { serverUrl } = await getSettings();
    try {
      new URL(serverUrl);
    } catch {
      return;
    }

    let res: Response;
    try {
      res = await swFetchAuthenticated(
        EXT_API_PATH.EXTENSION_TOKEN_REFRESH,
        { method: "POST" },
        serverUrl,
        token,
      );
    } catch (err) {
      if (err instanceof DpopSignError) {
        // Transient WebCrypto failure — do not sign out; retry next alarm cycle.
        return;
      }
      throw err;
    }

    if (res.ok) {
      const data = (await res.json()) as {
        token: string;
        expiresAt: string;
        scope: string[];
      };
      const newExpiresAt = new Date(data.expiresAt).getTime();
      callbacks.setToken(data.token, newExpiresAt);
      callbacks.createTtlAlarm(newExpiresAt);
      callbacks.scheduleRefreshAlarm(newExpiresAt);
    } else if (res.status === 401 || res.status === 403 || res.status === 404) {
      callbacks.clearToken();
    } else {
      // Transient error (429, 5xx) — retry if enough TTL remains
      if (tokenExpiresAt - Date.now() > 60_000) {
        callbacks.scheduleRefreshAlarm(tokenExpiresAt);
      }
    }
  } catch {
    // Network error — keep current token, retry next cycle.
    const tokenExpiresAt = callbacks.getTokenExpiresAt();
    if (tokenExpiresAt && tokenExpiresAt - Date.now() > 60_000) {
      callbacks.scheduleRefreshAlarm(tokenExpiresAt);
    }
  }
}

// ── Token revocation ──────────────────────────────────────────

export interface TokenRevokeCallbacks {
  getCurrentToken(): string | null;
}

export async function revokeTokenOnServerWith(
  callbacks: TokenRevokeCallbacks,
): Promise<void> {
  const token = callbacks.getCurrentToken();
  if (!token) return;
  try {
    const { serverUrl } = await getSettings();
    try {
      new URL(serverUrl);
    } catch {
      return;
    }
    await swFetchAuthenticated(
      EXT_API_PATH.EXTENSION_TOKEN,
      { method: "DELETE" },
      serverUrl,
      token,
    );
  } catch {
    // Best-effort revoke; local clear still proceeds.
  }
}
