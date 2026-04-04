// ── Extension ↔ Service Worker messages ──────────────────────

import { EXT_MSG } from "../lib/constants";

export type ExtensionMessage =
  | { type: typeof EXT_MSG.SET_TOKEN; token: string; expiresAt: number }
  | { type: typeof EXT_MSG.GET_TOKEN }
  | { type: typeof EXT_MSG.CLEAR_TOKEN }
  | { type: typeof EXT_MSG.GET_STATUS }
  | { type: typeof EXT_MSG.UNLOCK_VAULT; passphrase: string }
  | { type: typeof EXT_MSG.LOCK_VAULT }
  | { type: typeof EXT_MSG.FETCH_PASSWORDS }
  | { type: typeof EXT_MSG.COPY_PASSWORD; entryId: string; teamId?: string }
  | { type: typeof EXT_MSG.AUTOFILL; entryId: string; tabId: number; teamId?: string }
  | { type: typeof EXT_MSG.GET_MATCHES_FOR_URL; url: string; topUrl?: string }
  | { type: typeof EXT_MSG.COPY_TOTP; entryId: string; teamId?: string }
  | {
      type: typeof EXT_MSG.AUTOFILL_FROM_CONTENT;
      entryId: string;
      targetHint?: AutofillTargetHint;
      teamId?: string;
    }
  | { type: typeof EXT_MSG.LOGIN_DETECTED; url: string; username: string; password: string }
  | { type: typeof EXT_MSG.SAVE_LOGIN; url: string; title: string; username: string; password: string }
  | { type: typeof EXT_MSG.UPDATE_LOGIN; entryId: string; password: string }
  | { type: typeof EXT_MSG.DISMISS_SAVE_PROMPT }
  | { type: typeof EXT_MSG.CHECK_PENDING_SAVE }
  | { type: typeof EXT_MSG.AUTOFILL_CREDIT_CARD; entryId: string; tabId: number; teamId?: string }
  | { type: typeof EXT_MSG.AUTOFILL_IDENTITY; entryId: string; tabId: number; teamId?: string }
  | { type: typeof EXT_MSG.KEEPALIVE_PING }
  // Passkey SW messages — senderUrl is intentionally absent: the SW reads it
  // from chrome.runtime.MessageSender (_sender.tab?.url), not from the message payload,
  // to prevent the content script from spoofing the sender origin.
  | { type: typeof EXT_MSG.PASSKEY_GET_MATCHES; rpId: string }
  | {
      type: typeof EXT_MSG.PASSKEY_SIGN_ASSERTION;
      entryId: string;
      clientDataJSON: string;
      teamId?: string;
    }
  | {
      type: typeof EXT_MSG.PASSKEY_CHECK_DUPLICATE;
      rpId: string;
      userName: string;
    }
  | {
      type: typeof EXT_MSG.PASSKEY_CREATE_CREDENTIAL;
      rpId: string;
      rpName: string;
      userId: string;
      userName: string;
      userDisplayName: string;
      excludeCredentialIds: string[];
      clientDataJSON: string;
      replaceEntryId?: string;
    };

export interface DecryptedEntry {
  id: string;
  title: string;
  username: string;
  urlHost: string;
  additionalUrlHosts?: string[];
  entryType: string;
  teamId?: string;
  teamName?: string;
  // Passkey provider fields (populated for PASSKEY entries)
  relyingPartyId?: string;
  credentialId?: string;
  creationDate?: string;
}

// ── Passkey provider types ──

export interface PasskeyMatchEntry {
  id: string;
  title: string;
  username: string;
  relyingPartyId: string;
  credentialId: string;
  creationDate?: string;
  teamId?: string;
}

export interface SerializedAssertionResponse {
  credentialId: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
  clientDataJSON: string;
}

export interface SerializedAttestationResponse {
  credentialId: string;
  attestationObject: string;
  clientDataJSON: string;
  authData: string;
  publicKeyDer: string;
  transports: string[];
}

export type ExtensionResponse =
  | { type: typeof EXT_MSG.SET_TOKEN; ok: true }
  | { type: typeof EXT_MSG.GET_TOKEN; token: string | null }
  | { type: typeof EXT_MSG.CLEAR_TOKEN; ok: true }
  | { type: typeof EXT_MSG.GET_STATUS; hasToken: boolean; expiresAt: number | null; vaultUnlocked: boolean }
  | { type: typeof EXT_MSG.UNLOCK_VAULT; ok: boolean; error?: string }
  | { type: typeof EXT_MSG.LOCK_VAULT; ok: true }
  | { type: typeof EXT_MSG.FETCH_PASSWORDS; entries: DecryptedEntry[] | null; error?: string }
  | { type: typeof EXT_MSG.COPY_PASSWORD; password: string | null; error?: string }
  | { type: typeof EXT_MSG.AUTOFILL; ok: boolean; error?: string }
  | {
      type: typeof EXT_MSG.GET_MATCHES_FOR_URL;
      entries: DecryptedEntry[];
      vaultLocked: boolean;
      disconnected?: boolean;
      suppressInline?: boolean;
    }
  | { type: typeof EXT_MSG.COPY_TOTP; code: string | null; error?: string }
  | { type: typeof EXT_MSG.AUTOFILL_FROM_CONTENT; ok: boolean; error?: string }
  | { type: typeof EXT_MSG.LOGIN_DETECTED; action: "save" | "update" | "none"; existingEntryId?: string; existingTitle?: string }
  | { type: typeof EXT_MSG.SAVE_LOGIN; ok: boolean; error?: string }
  | { type: typeof EXT_MSG.UPDATE_LOGIN; ok: boolean; error?: string }
  | { type: typeof EXT_MSG.DISMISS_SAVE_PROMPT; ok: true }
  | {
      type: typeof EXT_MSG.CHECK_PENDING_SAVE;
      action: "save" | "update" | "none";
      host?: string;
      username?: string;
      password?: string;
      existingEntryId?: string;
      existingTitle?: string;
    }
  | { type: typeof EXT_MSG.AUTOFILL_CREDIT_CARD; ok: boolean; error?: string }
  | { type: typeof EXT_MSG.AUTOFILL_IDENTITY; ok: boolean; error?: string }
  | {
      type: typeof EXT_MSG.PASSKEY_GET_MATCHES;
      entries: PasskeyMatchEntry[];
      vaultLocked: boolean;
    }
  | {
      type: typeof EXT_MSG.PASSKEY_SIGN_ASSERTION;
      ok: boolean;
      response?: SerializedAssertionResponse;
      error?: string;
    }
  | {
      type: typeof EXT_MSG.PASSKEY_CHECK_DUPLICATE;
      entries: PasskeyMatchEntry[];
      vaultLocked?: boolean;
    }
  | {
      type: typeof EXT_MSG.PASSKEY_CREATE_CREDENTIAL;
      ok: boolean;
      response?: SerializedAttestationResponse;
      error?: string;
    };

export interface AutofillPayload {
  type: "AUTOFILL_FILL";
  username: string;
  password: string;
  targetHint?: AutofillTargetHint;
  totpCode?: string;
  customFields?: Array<{ label: string; value: string }>;
}

export interface AutofillTargetHint {
  id?: string;
  name?: string;
  type?: string;
  autocomplete?: string;
}

// ── Credit Card autofill payload ──

export interface CreditCardAutofillPayload {
  type: "AUTOFILL_CC_FILL";
  cardholderName: string;
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}

// ── Identity autofill payload ──

export interface IdentityAutofillPayload {
  type: "AUTOFILL_IDENTITY_FILL";
  fullName: string;
  address: string;
  postalCode: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  nationality: string;
  idNumber: string;
}
