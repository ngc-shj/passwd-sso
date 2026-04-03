/**
 * Persist auth state to chrome.storage.session.
 * Survives service worker restarts but clears on browser close.
 *
 * Sensitive fields (token, vaultSecretKey) are encrypted with an ephemeral
 * wrapping key before storage. If the SW is terminated and restarted,
 * the ephemeral key is lost and decryption fails → user must re-authenticate.
 */

import { SESSION_KEY } from "./constants";
import {
  encryptField,
  decryptField,
  type EncryptedField,
} from "./session-crypto";

/** Shape stored in chrome.storage.session (encrypted form). */
interface StoredSessionState {
  encryptedToken: EncryptedField;
  expiresAt: number;
  userId?: string;
  encryptedVaultSecretKey?: EncryptedField;
  ecdhEncrypted?: { ciphertext: string; iv: string; authTag: string };
}

/** Shape returned to callers after decryption. */
export interface SessionState {
  token: string;
  expiresAt: number;
  userId?: string;
  vaultSecretKey?: string;
  /** Encrypted ECDH private key (hex) for team key derivation — re-unwrapped on SW restart */
  ecdhEncrypted?: { ciphertext: string; iv: string; authTag: string };
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
  const [encryptedToken, encryptedVaultSecretKey] = await Promise.all([
    encryptField(state.token),
    state.vaultSecretKey ? encryptField(state.vaultSecretKey) : Promise.resolve(undefined),
  ]);
  if (!encryptedToken) return; // Encryption failed — don't persist

  const stored: StoredSessionState = {
    encryptedToken,
    expiresAt: state.expiresAt,
    userId: state.userId,
    encryptedVaultSecretKey,
    ecdhEncrypted: state.ecdhEncrypted,
  };
  await chrome.storage.session.set({ [SESSION_KEY]: stored });
}

export async function loadSession(): Promise<SessionState | null> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const raw = result[SESSION_KEY];
  if (!raw || typeof raw !== "object") return null;

  // Backward compat: reject old plaintext format (token as string)
  if (typeof raw.token === "string") return null;

  // Validate encrypted format
  if (!isEncryptedField(raw.encryptedToken) || typeof raw.expiresAt !== "number") {
    return null;
  }

  // Decrypt token
  const token = await decryptField(raw.encryptedToken);
  if (!token) return null; // Ephemeral key lost or corrupted

  // Decrypt vaultSecretKey if present
  let vaultSecretKey: string | undefined;
  if (raw.encryptedVaultSecretKey !== undefined) {
    if (!isEncryptedField(raw.encryptedVaultSecretKey)) return null;
    const decrypted = await decryptField(raw.encryptedVaultSecretKey);
    if (decrypted) vaultSecretKey = decrypted;
    // If decryption fails, vaultSecretKey is simply undefined (vault locked)
  }

  // userId validation
  if (raw.userId !== undefined && typeof raw.userId !== "string") return null;

  // ecdhEncrypted validation (existing logic)
  if (raw.ecdhEncrypted !== undefined) {
    if (!isEncryptedField(raw.ecdhEncrypted)) return null;
  }

  return {
    token,
    expiresAt: raw.expiresAt,
    userId: raw.userId,
    vaultSecretKey,
    ecdhEncrypted: raw.ecdhEncrypted,
  };
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
