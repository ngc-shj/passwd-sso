/**
 * Extracted token lifecycle helpers for testability (Round 2 T23).
 *
 * These functions are consumed by index.ts and can be imported directly
 * in unit tests without instantiating the full service worker.
 */

import { EXT_API_PATH } from "../lib/api-paths";
import { getSettings } from "../lib/storage";
import { DpopSignError, swFetchAuthenticated } from "./dpop-fetch";

// ── Helpers ────────────────────────────────────────────────────

async function getValidServerUrl(): Promise<string | null> {
  const { serverUrl } = await getSettings();
  try {
    new URL(serverUrl);
    return serverUrl;
  } catch {
    return null;
  }
}

// ── Token refresh ──────────────────────────────────────────────

export interface TokenRefreshCallbacks {
  getCurrentToken(): string | null;
  getTokenExpiresAt(): number | null;
  setToken(token: string, expiresAt: number): void;
  /** Called when the refresh response includes a new cnfJkt (C10 binding propagation). */
  setCnfJkt?(cnfJkt: string): void;
  clearToken(): void;
  scheduleRefreshAlarm(expiresAt: number): void;
  createTtlAlarm(when: number): void;
}

export async function attemptTokenRefreshWith(
  callbacks: TokenRefreshCallbacks,
): Promise<void> {
  const token = callbacks.getCurrentToken();
  const tokenExpiresAt = callbacks.getTokenExpiresAt();
  // DIAG
  console.log("[psso] attemptTokenRefresh start", {
    hasToken: token !== null,
    expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
  });
  if (!token || !tokenExpiresAt) { console.log("[psso] refresh skip: no token state"); return; }
  if (Date.now() >= tokenExpiresAt) { console.log("[psso] refresh skip: already expired"); return; }

  try {
    const serverUrl = await getValidServerUrl();
    if (!serverUrl) { console.log("[psso] refresh skip: no serverUrl"); return; }

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
        console.log("[psso] refresh skip: DpopSignError", err);
        return;
      }
      console.error("[psso] refresh swFetch throw", err);
      throw err;
    }

    console.log("[psso] refresh response", res.status);
    if (res.ok) {
      const data = (await res.json()) as {
        token: string;
        expiresAt: string;
        scope: string[];
        cnfJkt?: string;
      };
      const newExpiresAt = new Date(data.expiresAt).getTime();
      callbacks.setToken(data.token, newExpiresAt);
      // Carry forward cnfJkt from refresh response (server preserves binding per C10).
      if (typeof data.cnfJkt === "string" && callbacks.setCnfJkt) {
        callbacks.setCnfJkt(data.cnfJkt);
      }
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
    const serverUrl = await getValidServerUrl();
    if (!serverUrl) return;
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
