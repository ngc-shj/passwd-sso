/**
 * Extracted token lifecycle helpers for testability (Round 2 T23).
 *
 * These functions are consumed by index.ts and can be imported directly
 * in unit tests without instantiating the full service worker.
 */

import { EXT_API_PATH } from "../lib/api-paths";
import { BRIDGE_CODE_LENGTH } from "../lib/constants";
import { getSettings } from "../lib/storage";
import { signDpopProof } from "../lib/dpop-key";
import { DpopSignError, swFetchAuthenticated } from "./dpop-fetch";
import { MS_PER_MINUTE } from "../lib/time";

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
  if (!token || !tokenExpiresAt) return;
  if (Date.now() >= tokenExpiresAt) return;

  try {
    const serverUrl = await getValidServerUrl();
    if (!serverUrl) return;

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
      if (tokenExpiresAt - Date.now() > MS_PER_MINUTE) {
        callbacks.scheduleRefreshAlarm(tokenExpiresAt);
      }
    }
  } catch {
    // Network error — keep current token, retry next cycle.
    const tokenExpiresAt = callbacks.getTokenExpiresAt();
    if (tokenExpiresAt && tokenExpiresAt - Date.now() > MS_PER_MINUTE) {
      callbacks.scheduleRefreshAlarm(tokenExpiresAt);
    }
  }
}

// ── Initial connect (bridge-code → exchange) ──────────────────

export interface StartConnectCallbacks {
  /**
   * Persist the issued token + expiry + cnfJkt into SW in-memory + session
   * storage state. Invoked exactly once on success, never on failure.
   */
  setToken(token: string, expiresAt: number, cnfJkt: string): void;
  /**
   * Optional injection point so tests can swap fetch without touching globalThis.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional injection point so tests can swap signDpopProof without touching
   * the IDB-backed module-level helper.
   */
  signDpopProofImpl?: typeof signDpopProof;
}

export interface StartConnectResult {
  ok: boolean;
  errorCode?: string;
}

interface BridgeCodeResponse {
  code: string;
  expiresAt: string;
}

interface ExchangeResponse {
  token: string;
  expiresAt: string;
  scope: string[];
  cnfJkt: string;
}

/**
 * Drive the bridge-code + exchange handshake end-to-end. Two-step flow:
 *
 *   1. POST /api/extension/bridge-code with credentials + DPoP proof. The web
 *      app's session cookie authenticates the user; the DPoP proof binds the
 *      issued bridge code to the SW's key. Empty body ({}). Response carries
 *      the one-time code.
 *   2. POST /api/extension/token/exchange (no credentials, just DPoP signed
 *      by the same key) to swap the code for a Bearer token. The server
 *      verifies dpopResult.jkt === bridge_code.cnf_jkt before consuming.
 *
 * On success the callback persists the token; on any failure no token is
 * persisted and the error code is returned for the caller to propagate to
 * the web app via EXT_CONNECT_READY.
 *
 * Error code conventions (mirrors web-app helper's ExtensionConnectErrorCode):
 *   - "SESSION_STEP_UP_REQUIRED" — server returned 403 with this code on the
 *     bridge-code endpoint (recent-current-auth-method gate failed).
 *   - "GENERIC_FAILURE" — every other failure shape.
 */
export async function startConnect(
  callbacks: StartConnectCallbacks,
): Promise<StartConnectResult> {
  const fetchFn = callbacks.fetchImpl ?? fetch;
  const signFn = callbacks.signDpopProofImpl ?? signDpopProof;

  const serverUrl = await getValidServerUrl();
  if (!serverUrl) return { ok: false, errorCode: "GENERIC_FAILURE" };

  // Step 1: bridge-code (credentialed; no access token yet → no `ath`).
  let bridgeCode: string;
  try {
    const proof = await signFn({
      route: EXT_API_PATH.EXTENSION_BRIDGE_CODE,
      method: "POST",
      serverUrl,
    });
    // String concat (not new URL) — serverUrl may carry a basePath such as
    // `/passwd-sso`; `new URL("/api/...", serverUrl)` would discard that
    // basePath because absolute paths override the base's pathname. Mirrors
    // the swFetchAuthenticated helper's `${serverUrl}${path}` pattern.
    const res = await fetchFn(
      `${serverUrl}${EXT_API_PATH.EXTENSION_BRIDGE_CODE}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          DPoP: proof,
        },
        body: "{}",
      },
    );
    if (!res.ok) {
      const errorCode = await extractErrorCode(res);
      return { ok: false, errorCode };
    }
    const data = (await res.json()) as BridgeCodeResponse;
    if (typeof data.code !== "string" || data.code.length !== BRIDGE_CODE_LENGTH) {
      return { ok: false, errorCode: "GENERIC_FAILURE" };
    }
    bridgeCode = data.code;
  } catch (err) {
    if (err instanceof DpopSignError) {
      return { ok: false, errorCode: "GENERIC_FAILURE" };
    }
    return { ok: false, errorCode: "GENERIC_FAILURE" };
  }

  // Step 2: exchange (no credentials — content-script/SW origin would fail
  // assertOrigin if cookies were sent; the bridge code + DPoP are the auth).
  try {
    const proof = await signFn({
      route: EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE,
      method: "POST",
      serverUrl,
    });
    // Same basePath-preserving string concat as the bridge-code fetch above.
    const res = await fetchFn(
      `${serverUrl}${EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE}`,
      {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          DPoP: proof,
        },
        body: JSON.stringify({ code: bridgeCode }),
      },
    );
    if (!res.ok) {
      const errorCode = await extractErrorCode(res);
      return { ok: false, errorCode };
    }
    const data = (await res.json()) as ExchangeResponse;
    const expiresAtMs = new Date(data.expiresAt).getTime();
    if (
      typeof data.token !== "string" ||
      typeof data.cnfJkt !== "string" ||
      !Number.isFinite(expiresAtMs)
    ) {
      return { ok: false, errorCode: "GENERIC_FAILURE" };
    }
    callbacks.setToken(data.token, expiresAtMs, data.cnfJkt);
    return { ok: true };
  } catch (err) {
    if (err instanceof DpopSignError) {
      return { ok: false, errorCode: "GENERIC_FAILURE" };
    }
    return { ok: false, errorCode: "GENERIC_FAILURE" };
  }
}

async function extractErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") {
      // Only propagate codes the web-app helper knows how to react to.
      if (body.error === "SESSION_STEP_UP_REQUIRED") return body.error;
    }
  } catch {
    // ignore — response body not JSON
  }
  return "GENERIC_FAILURE";
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
