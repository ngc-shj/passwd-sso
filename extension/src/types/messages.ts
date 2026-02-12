// ── Extension ↔ Service Worker messages ──────────────────────

export type ExtensionMessage =
  | { type: "SET_TOKEN"; token: string; expiresAt: number }
  | { type: "GET_TOKEN" }
  | { type: "CLEAR_TOKEN" }
  | { type: "GET_STATUS" }
  | { type: "UNLOCK_VAULT"; passphrase: string }
  | { type: "LOCK_VAULT" }
  | { type: "FETCH_PASSWORDS" };

export interface DecryptedEntry {
  id: string;
  title: string;
  username: string;
  urlHost: string;
  entryType: string;
}

export type ExtensionResponse =
  | { type: "SET_TOKEN"; ok: true }
  | { type: "GET_TOKEN"; token: string | null }
  | { type: "CLEAR_TOKEN"; ok: true }
  | { type: "GET_STATUS"; hasToken: boolean; expiresAt: number | null; vaultUnlocked: boolean }
  | { type: "UNLOCK_VAULT"; ok: boolean; error?: string }
  | { type: "LOCK_VAULT"; ok: true }
  | { type: "FETCH_PASSWORDS"; entries: DecryptedEntry[] | null; error?: string };
