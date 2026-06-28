/**
 * Records WHY the extension's connection ended so the popup can explain it
 * instead of showing a context-free "Connect" prompt.
 *
 * Stored under DISCONNECT_REASON_KEY (separate from SESSION_KEY) in
 * chrome.storage.session — the reason is only meaningful for the current
 * browser run, the same lifetime as the token it describes. The value is
 * non-sensitive (an enum string), so it is not encrypted.
 */

import { DISCONNECT_REASON_KEY } from "./constants";

export const DISCONNECT_REASON = {
  /** Token aged out (TTL alarm or lazy expiry check). */
  EXPIRED: "expired",
  /** Server rejected refresh (401/403/404) — the session is no longer valid. */
  REVOKED: "revoked",
  /** Vault auto-lock fired with the LOGOUT action. */
  TIMEOUT_LOGOUT: "timeout_logout",
  /** User clicked Disconnect. */
  MANUAL: "manual",
} as const;

export type DisconnectReason =
  (typeof DISCONNECT_REASON)[keyof typeof DISCONNECT_REASON];

const REASONS = new Set<string>(Object.values(DISCONNECT_REASON));

export async function recordDisconnectReason(
  reason: DisconnectReason,
): Promise<void> {
  try {
    await chrome.storage.session.set({ [DISCONNECT_REASON_KEY]: reason });
  } catch {
    // Best-effort — a missing reason just falls back to the generic prompt.
  }
}

export async function readDisconnectReason(): Promise<DisconnectReason | null> {
  try {
    const result = await chrome.storage.session.get(DISCONNECT_REASON_KEY);
    const raw = result[DISCONNECT_REASON_KEY];
    if (typeof raw === "string" && REASONS.has(raw)) {
      return raw as DisconnectReason;
    }
  } catch {
    // ignore — treat as no recorded reason
  }
  return null;
}

export async function clearDisconnectReason(): Promise<void> {
  try {
    await chrome.storage.session.remove(DISCONNECT_REASON_KEY);
  } catch {
    // ignore
  }
}
