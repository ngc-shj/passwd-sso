// ── Extension ↔ Service Worker messages ──────────────────────

export type ExtensionMessage =
  | { type: "SET_TOKEN"; token: string; expiresAt: number }
  | { type: "GET_TOKEN" }
  | { type: "CLEAR_TOKEN" }
  | { type: "GET_STATUS" }
  | { type: "UNLOCK_VAULT"; passphrase: string }
  | { type: "LOCK_VAULT" }
  | { type: "FETCH_PASSWORDS" }
  | { type: "COPY_PASSWORD"; entryId: string; teamId?: string }
  | { type: "AUTOFILL"; entryId: string; tabId: number; teamId?: string }
  | { type: "GET_MATCHES_FOR_URL"; url: string; topUrl?: string }
  | { type: "COPY_TOTP"; entryId: string; teamId?: string }
  | {
      type: "AUTOFILL_FROM_CONTENT";
      entryId: string;
      targetHint?: AutofillTargetHint;
      teamId?: string;
    }
  | { type: "LOGIN_DETECTED"; url: string; username: string; password: string }
  | { type: "SAVE_LOGIN"; url: string; title: string; username: string; password: string }
  | { type: "UPDATE_LOGIN"; entryId: string; password: string }
  | { type: "DISMISS_SAVE_PROMPT" }
  | { type: "CHECK_PENDING_SAVE" }
  | { type: "AUTOFILL_CREDIT_CARD"; entryId: string; tabId: number; teamId?: string }
  | { type: "AUTOFILL_IDENTITY"; entryId: string; tabId: number; teamId?: string }
  | { type: "KEEPALIVE_PING" }
  | { type: "PASSKEY_GET_MATCHES"; rpId: string }
  | {
      type: "PASSKEY_SIGN_ASSERTION";
      entryId: string;
      clientDataJSON: string;
      teamId?: string;
    }
  | {
      type: "PASSKEY_CREATE_CREDENTIAL";
      rpId: string;
      rpName: string;
      userId: string;
      userName: string;
      userDisplayName: string;
      excludeCredentialIds: string[];
      clientDataJSON: string;
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
}

// ── Passkey provider types ──

export interface PasskeyMatchEntry {
  id: string;
  title: string;
  username: string;
  relyingPartyId: string;
  credentialId: string;
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
    }
  | { type: "AUTOFILL_CREDIT_CARD"; ok: boolean; error?: string }
  | { type: "AUTOFILL_IDENTITY"; ok: boolean; error?: string }
  | {
      type: "PASSKEY_GET_MATCHES";
      entries: PasskeyMatchEntry[];
      vaultLocked: boolean;
    }
  | {
      type: "PASSKEY_SIGN_ASSERTION";
      ok: boolean;
      response?: SerializedAssertionResponse;
      error?: string;
    }
  | {
      type: "PASSKEY_CREATE_CREDENTIAL";
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
