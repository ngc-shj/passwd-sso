/**
 * Persist auth state to chrome.storage.session.
 * Survives service worker restarts but clears on browser close.
 *
 * `token` is stored in plain text — it must survive SW termination, which the
 * ephemeral wrapping key by design does not (C11). `vaultSecretKey` keeps the
 * ephemeral-key wrapping: it must NOT survive SW death, only the loss of the
 * unlocked vault, so an SW restart re-locks the vault while keeping the
 * connection alive. The accepted exposure (any trusted extension context can
 * read the plain token) and the compensating control (non-extractable DPoP
 * key bound to the token, verified against IDB on hydrate) are documented in
 * docs/archive/review/long-lived-client-login-plan.md C11.
 */

import { SESSION_KEY, JKT_RE } from "./constants";
import {
  encryptField,
  decryptField,
  type EncryptedField,
} from "./session-crypto";

/** Shape stored in chrome.storage.session. */
interface StoredSessionState {
  token: string;
  expiresAt: number;
  userId?: string;
  encryptedVaultSecretKey?: EncryptedField;
  ecdhEncrypted?: { ciphertext: string; iv: string; authTag: string };
  /**
   * Tenant-policy auto-lock value learned from the server at vault-unlock
   * time. Persisted so the SW can restore it on restart (otherwise the
   * options UI would see null and keep the local auto-lock select enabled
   * until the user unlocks the vault again).
   * Plain number; not sensitive.
   */
  tenantAutoLockMinutes?: number | null;
  /**
   * Tenant policy override forcing "logout" as the vault-timeout action
   * (C10). Same persistence rationale as tenantAutoLockMinutes. Plain
   * boolean; not sensitive.
   */
  requireVaultTimeoutLogout?: boolean | null;
  /** RFC 7638 JWK thumbprint of the DPoP key bound to the current token (43 base64url chars). */
  tokenCnfJkt?: string;
  /** Personal vault key version at the time of unlock. Used to stamp saved entries correctly. */
  personalKeyVersion?: number;
}

/** Shape returned to callers after decryption. */
export interface SessionState {
  token: string;
  expiresAt: number;
  userId?: string;
  vaultSecretKey?: string;
  /** Encrypted ECDH private key (hex) for team key derivation — re-unwrapped on SW restart */
  ecdhEncrypted?: { ciphertext: string; iv: string; authTag: string };
  tenantAutoLockMinutes?: number | null;
  requireVaultTimeoutLogout?: boolean | null;
  /** RFC 7638 JWK thumbprint of the DPoP key bound to the current token (43 base64url chars). */
  tokenCnfJkt: string;
  /** Personal vault key version at the time of unlock. Used to stamp saved entries correctly. */
  personalKeyVersion?: number;
}

function isEncryptedField(v: unknown): v is EncryptedField {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as EncryptedField).ciphertext === "string" &&
    typeof (v as EncryptedField).iv === "string" &&
    typeof (v as EncryptedField).authTag === "string"
  );
}

export async function persistSession(state: SessionState): Promise<void> {
  const encryptedVaultSecretKey = state.vaultSecretKey
    ? await encryptField(state.vaultSecretKey)
    : undefined;
  // vaultSecretKey encryption failed — persist the token/session anyway (S1:
  // the vault simply won't survive an SW restart, same as if it were absent).
  const stored: StoredSessionState = {
    token: state.token,
    expiresAt: state.expiresAt,
    userId: state.userId,
    encryptedVaultSecretKey:
      state.vaultSecretKey && encryptedVaultSecretKey
        ? encryptedVaultSecretKey
        : undefined,
    ecdhEncrypted: state.ecdhEncrypted,
    tenantAutoLockMinutes: state.tenantAutoLockMinutes ?? undefined,
    requireVaultTimeoutLogout: state.requireVaultTimeoutLogout ?? undefined,
    tokenCnfJkt: state.tokenCnfJkt,
    personalKeyVersion: state.personalKeyVersion,
  };
  await chrome.storage.session.set({ [SESSION_KEY]: stored });
}

export async function loadSession(): Promise<SessionState | null> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  // @types/chrome 0.2.x types get() values as unknown; the checks below narrow
  // each field, so read the row as an index map to reach them.
  const raw = result[SESSION_KEY] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;

  // token is plain text (C11) — validate shape only.
  if (typeof raw.token !== "string" || typeof raw.expiresAt !== "number") {
    return null;
  }

  // Decrypt vaultSecretKey if present. A decrypt failure (ephemeral key lost
  // on SW restart, or corrupted blob) leaves vaultSecretKey undefined — the
  // token is still restored and the vault simply stays locked (C11).
  let vaultSecretKey: string | undefined;
  if (raw.encryptedVaultSecretKey !== undefined) {
    if (!isEncryptedField(raw.encryptedVaultSecretKey)) return null;
    const decrypted = await decryptField(raw.encryptedVaultSecretKey);
    if (decrypted) vaultSecretKey = decrypted;
  }

  // userId validation
  if (raw.userId !== undefined && typeof raw.userId !== "string") return null;

  // ecdhEncrypted validation (existing logic)
  if (raw.ecdhEncrypted !== undefined) {
    if (!isEncryptedField(raw.ecdhEncrypted)) return null;
  }

  // tenantAutoLockMinutes validation
  let tenantAutoLockMinutes: number | null | undefined;
  if (raw.tenantAutoLockMinutes === undefined || raw.tenantAutoLockMinutes === null) {
    tenantAutoLockMinutes = null;
  } else if (typeof raw.tenantAutoLockMinutes === "number" && Number.isFinite(raw.tenantAutoLockMinutes)) {
    tenantAutoLockMinutes = raw.tenantAutoLockMinutes;
  } else {
    tenantAutoLockMinutes = null;
  }

  // requireVaultTimeoutLogout validation — absent/non-boolean defaults to
  // null ("unknown"; the effective action falls back to the local setting).
  const requireVaultTimeoutLogout: boolean | null =
    typeof raw.requireVaultTimeoutLogout === "boolean"
      ? raw.requireVaultTimeoutLogout
      : null;

  // tokenCnfJkt validation: must be a 43-char base64url string.
  // Absent means a pre-PR session — return null so the user reconnects cleanly.
  if (typeof raw.tokenCnfJkt !== "string" || !JKT_RE.test(raw.tokenCnfJkt)) {
    return null;
  }

  // personalKeyVersion validation
  let personalKeyVersion: number | undefined;
  if (typeof raw.personalKeyVersion === "number" && Number.isInteger(raw.personalKeyVersion) && raw.personalKeyVersion >= 0) {
    personalKeyVersion = raw.personalKeyVersion;
  }

  return {
    token: raw.token,
    expiresAt: raw.expiresAt,
    userId: raw.userId,
    vaultSecretKey,
    ecdhEncrypted: raw.ecdhEncrypted,
    tenantAutoLockMinutes,
    requireVaultTimeoutLogout,
    tokenCnfJkt: raw.tokenCnfJkt,
    personalKeyVersion,
  };
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
