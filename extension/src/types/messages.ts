// ── Extension ↔ Service Worker messages ──────────────────────

export type ExtensionMessage =
  | { type: "SET_TOKEN"; token: string; expiresAt: number }
  | { type: "GET_TOKEN" }
  | { type: "CLEAR_TOKEN" }
  | { type: "GET_STATUS" }
  | { type: "UNLOCK_VAULT"; passphrase: string }
  | { type: "LOCK_VAULT" }
  | { type: "FETCH_PASSWORDS" }
  | { type: "COPY_PASSWORD"; entryId: string }
  | { type: "AUTOFILL"; entryId: string; tabId: number }
  | { type: "GET_MATCHES_FOR_URL"; url: string; topUrl?: string }
  | { type: "COPY_TOTP"; entryId: string }
  | {
      type: "AUTOFILL_FROM_CONTENT";
      entryId: string;
      targetHint?: AutofillTargetHint;
    }
  | { type: "LOGIN_DETECTED"; url: string; username: string; password: string }
  | { type: "SAVE_LOGIN"; url: string; title: string; username: string; password: string }
  | { type: "UPDATE_LOGIN"; entryId: string; password: string }
  | { type: "DISMISS_SAVE_PROMPT" }
  | { type: "CHECK_PENDING_SAVE" };

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
  | { type: "FETCH_PASSWORDS"; entries: DecryptedEntry[] | null; error?: string }
  | { type: "COPY_PASSWORD"; password: string | null; error?: string }
  | { type: "AUTOFILL"; ok: boolean; error?: string }
  | {
      type: "GET_MATCHES_FOR_URL";
      entries: DecryptedEntry[];
      vaultLocked: boolean;
      disconnected?: boolean;
      suppressInline?: boolean;
    }
  | { type: "COPY_TOTP"; code: string | null; error?: string }
  | { type: "AUTOFILL_FROM_CONTENT"; ok: boolean; error?: string }
  | { type: "LOGIN_DETECTED"; action: "save" | "update" | "none"; existingEntryId?: string; existingTitle?: string }
  | { type: "SAVE_LOGIN"; ok: boolean; error?: string }
  | { type: "UPDATE_LOGIN"; ok: boolean; error?: string }
  | { type: "DISMISS_SAVE_PROMPT"; ok: true }
  | {
      type: "CHECK_PENDING_SAVE";
      action: "save" | "update" | "none";
      host?: string;
      username?: string;
      password?: string;
      existingEntryId?: string;
      existingTitle?: string;
    };

export interface AutofillPayload {
  type: "AUTOFILL_FILL";
  username: string;
  password: string;
  targetHint?: AutofillTargetHint;
  totpCode?: string;
  awsAccountIdOrAlias?: string;
  awsIamUsername?: string;
}

export interface AutofillTargetHint {
  id?: string;
  name?: string;
  type?: string;
  autocomplete?: string;
}
