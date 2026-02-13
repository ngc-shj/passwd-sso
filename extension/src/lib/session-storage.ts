/**
 * Persist auth state to chrome.storage.session.
 * Survives service worker restarts but clears on browser close.
 */

import { SESSION_KEY } from "./constants";

export interface SessionState {
  token: string;
  expiresAt: number; // ms timestamp
  userId?: string;
}

export async function persistSession(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: state });
}

export async function loadSession(): Promise<SessionState | null> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const raw = result[SESSION_KEY];
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.token !== "string" ||
    typeof raw.expiresAt !== "number"
  ) {
    return null;
  }
  // userId is optional (may not be set before vault unlock)
  if (raw.userId !== undefined && typeof raw.userId !== "string") {
    return null;
  }
  return raw as SessionState;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
