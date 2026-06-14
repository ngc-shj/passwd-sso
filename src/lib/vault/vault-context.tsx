"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import {
  deriveWrappingKey,
  deriveEncryptionKey,
  deriveAuthKey,
  generateSecretKey,
  generateAccountSalt,
  wrapSecretKey,
  unwrapSecretKey,
  computeAuthHash,
  computePassphraseVerifier,
  createVerificationArtifact,
  verifyKey,
  encryptBinary,
  decryptBinary,
  encryptData,
  decryptData,
} from "../crypto/crypto-client";
import { TeamVaultProvider } from "../team/team-vault-context";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  deriveEcdhWrappingKey,
} from "../crypto/crypto-team";
import {
  buildPersonalEntryAAD,
  buildAttachmentAAD,
  buildAttachmentCekWrapAAD,
  VAULT_TYPE,
  MIN_ACCEPTED_CEK_WRAP_AAD_VERSION,
  CURRENT_CEK_WRAP_AAD_VERSION,
} from "@/lib/crypto/crypto-aad";
import { API_PATH, apiPath, VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { fetchApi } from "@/lib/url-helpers";
import { hexDecode, hexEncode } from "../crypto/crypto-utils";
import { takePrf } from "@/lib/auth/prf-handoff";
import {
  startPasskeyAuthentication,
  unwrapSecretKeyWithPrf,
} from "../auth/webauthn/webauthn-client";
import { AutoLockProvider } from "./auto-lock-context";
import { EmergencyAccessProvider, confirmPendingEmergencyGrants } from "../emergency-access/emergency-access-context";
import { MS_PER_SECOND } from "@/lib/constants/time";

/** Error thrown by `unlock()` when the server rejects the request with a specific error code. */
export class VaultUnlockError extends Error {
  constructor(
    public readonly code: string,
    public readonly lockedUntil?: string | null,
  ) {
    super(code);
    this.name = "VaultUnlockError";
  }
}

/**
 * Parse a non-OK response from /api/vault/unlock/data and throw
 * VaultUnlockError(ACCOUNT_LOCKED) when the envelope signals lockout.
 * Called from all three unlock-data fetch sites so the behaviour is uniform.
 * @throws {VaultUnlockError} when error === ACCOUNT_LOCKED
 */
export async function throwIfUnlockDataLocked(res: Response): Promise<void> {
  const body = await res.json().catch(() => ({}));
  if (body.error === API_ERROR.ACCOUNT_LOCKED) {
    throw new VaultUnlockError(API_ERROR.ACCOUNT_LOCKED, body.lockedUntil);
  }
}

/**
 * Notify the server of a failed unlock attempt (for lockout tracking).
 * Sends a dummy authHash so the server records the failure and
 * returns lockout status (403) or rate-limit (429) if applicable.
 * @throws {VaultUnlockError} when server returns a structured error (e.g. ACCOUNT_LOCKED)
 * @internal Exported for testing
 */
export async function notifyUnlockFailure(): Promise<void> {
  const res = await fetchApi(API_PATH.VAULT_UNLOCK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authHash: "0".repeat(64) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error) {
      throw new VaultUnlockError(body.error, body.lockedUntil);
    }
  }
}

// Re-export so existing consumers can keep importing from vault-context
export type { VaultStatus };

/**
 * Side-effects of a vault key rotation, surfaced from the API to the dialog
 * so the UI can render operator banners (#433 / P3-F2). Counts of zero mean
 * "nothing was revoked"; null means "the post-tx invalidation call failed —
 * tokens may still be live, advise manual revocation".
 */
export interface RotationEffects {
  recoveryKeyInvalidated: boolean;
  emergencyGrantsCleared: number;
  prfCredentialsCleared: number;
  cekRewrapsAttempted: number;
  cekRewrapsSucceeded: number;
  cekRewrapsFailed: number;
  legacyAttachmentsMigrated: number;
  invalidatedMcpAccessTokens: number | null;
  invalidatedMcpRefreshTokens: number | null;
  cacheTombstoneFailures: number | null;
  invalidationFailed: boolean;
}

export interface TenantPasswordPolicy {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
}

interface VaultContextValue {
  status: VaultStatus;
  encryptionKey: CryptoKey | null;
  userId: string | null;
  hasRecoveryKey: boolean;
  recoveryKeyInvalidated: boolean;
  tenantPolicy: TenantPasswordPolicy;
  unlock: (passphrase: string) => Promise<boolean>;
  unlockWithPasskey: () => Promise<boolean>;
  unlockWithStoredPrf: () => Promise<boolean>;
  lock: () => void;
  setup: (passphrase: string) => Promise<void>;
  changePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
  rotateKey: (
    passphrase: string,
    onProgress?: (progress: { phase: "migrating" | "rewrapping" | "committing" | "entries" | "history", current: number, total: number }) => void,
  ) => Promise<RotationEffects | null>;
  verifyPassphrase: (passphrase: string) => Promise<boolean>;
  getSecretKey: () => Uint8Array | null;
  getAccountSalt: () => Uint8Array | null;
  getKeyVersion: () => number;
  setHasRecoveryKey: (value: boolean) => void;
  getEcdhPrivateKeyBytes: () => Uint8Array | null;
  getEcdhPublicKeyJwk: () => string | null;
}

const VaultContext = createContext<VaultContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────────

export function VaultProvider({ children }: { children: ReactNode }) {
  const { data: session, status: sessionStatus, update } = useSession();
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>(VAULT_STATUS.LOADING);
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(false);
  const [recoveryKeyInvalidated, setRecoveryKeyInvalidated] = useState(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState<number | null>(null);
  const [tenantPolicy, setTenantPolicy] = useState<TenantPasswordPolicy>({
    minPasswordLength: 0,
    requireUppercase: false,
    requireLowercase: false,
    requireNumbers: false,
    requireSymbols: false,
  });
  const secretKeyRef = useRef<Uint8Array | null>(null);
  const keyVersionRef = useRef<number>(0);
  const accountSaltRef = useRef<Uint8Array | null>(null);
  const wrappedKeyRef = useRef<{ ciphertext: string; iv: string; authTag: string } | null>(null);
  // ECDH key pair for team E2E encryption
  const ecdhPrivateKeyBytesRef = useRef<Uint8Array | null>(null);
  const ecdhPublicKeyJwkRef = useRef<string | null>(null);

  // ─── Fetch vault status on session load ───────────────────────

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !session?.user) {
      if (sessionStatus === "unauthenticated") {
        setVaultStatus(VAULT_STATUS.LOCKED);
      }
      return;
    }

    async function checkVaultStatus() {
      try {
        const res = await fetchApi(API_PATH.VAULT_STATUS);
        if (!res.ok) {
          setVaultStatus((prev) => prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED);
          return;
        }
        const data = await res.json();
        setHasRecoveryKey(!!data.hasRecoveryKey);
        setRecoveryKeyInvalidated(!!data.recoveryKeyInvalidated);
        // Apply tenant-configured vault auto-lock timeout
        if (data.vaultAutoLockMinutes != null && data.vaultAutoLockMinutes > 0) {
          setAutoLockMinutes(data.vaultAutoLockMinutes);
        }
        // Store tenant password policy for enforcement in personal vault forms
        setTenantPolicy({
          minPasswordLength: data.tenantMinPasswordLength ?? 0,
          requireUppercase: data.tenantRequireUppercase ?? false,
          requireLowercase: data.tenantRequireLowercase ?? false,
          requireNumbers: data.tenantRequireNumbers ?? false,
          requireSymbols: data.tenantRequireSymbols ?? false,
        });
        setVaultStatus((prev) => {
          // SETUP_REQUIRED always wins (vault was reset while unlocked)
          if (data.setupRequired) return VAULT_STATUS.SETUP_REQUIRED;
          // Never overwrite "unlocked" — only the lock timer should do that
          if (prev === VAULT_STATUS.UNLOCKED) return prev;
          return VAULT_STATUS.LOCKED;
        });
      } catch {
        setVaultStatus((prev) => prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED);
      }
    }

    checkVaultStatus();
  }, [session, sessionStatus]);

  // ─── Timeout fallback for LOADING state ──────────────────────
  // If session sync stalls after OIDC re-auth, retry then fall back to LOCKED

  useEffect(() => {
    if (vaultStatus !== VAULT_STATUS.LOADING) return;

    // First timeout: force a session refresh after 10s
    const retryTimer = setTimeout(() => {
      updateRef.current();
    }, 10 * MS_PER_SECOND);

    // Second timeout: if still LOADING after 15s, show lock screen
    const fallbackTimer = setTimeout(() => {
      setVaultStatus((prev) =>
        prev === VAULT_STATUS.LOADING ? VAULT_STATUS.LOCKED : prev,
      );
    }, 15 * MS_PER_SECOND);

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(fallbackTimer);
    };
  }, [vaultStatus]);

  const lock = useCallback(() => {
    // Revoke all delegation sessions (best-effort, survives page unload)
    fetchApi(API_PATH.VAULT_DELEGATION, { method: "DELETE", keepalive: true }).catch(() => {});
    if (secretKeyRef.current) {
      secretKeyRef.current.fill(0);
      secretKeyRef.current = null;
    }
    if (ecdhPrivateKeyBytesRef.current) {
      ecdhPrivateKeyBytesRef.current.fill(0);
      ecdhPrivateKeyBytesRef.current = null;
    }
    ecdhPublicKeyJwkRef.current = null;
    wrappedKeyRef.current = null;
    setEncryptionKey(null);
    setVaultStatus((prev) =>
      prev === VAULT_STATUS.UNLOCKED ? VAULT_STATUS.LOCKED : prev
    );
  }, []);

  // ─── SecretKey cleanup on unmount / page unload ─────────────

  useEffect(() => {
    const zeroSensitiveKeys = () => {
      if (secretKeyRef.current) {
        // Vault is unlocked — revoke delegations before zeroing keys
        fetchApi(API_PATH.VAULT_DELEGATION, { method: "DELETE", keepalive: true }).catch(() => {});
        secretKeyRef.current.fill(0);
        secretKeyRef.current = null;
      }
      if (ecdhPrivateKeyBytesRef.current) {
        ecdhPrivateKeyBytesRef.current.fill(0);
        ecdhPrivateKeyBytesRef.current = null;
      }
    };
    window.addEventListener("pagehide", zeroSensitiveKeys);
    return () => {
      window.removeEventListener("pagehide", zeroSensitiveKeys);
      zeroSensitiveKeys(); // also zero on unmount
    };
  }, []);

  // ─── bfcache restore guard (INV-C1.6) ────────────────────────
  // When the browser restores a bfcache page, the pagehide handler has already
  // zeroed secretKeyRef. If vaultStatus still reads UNLOCKED (the "never-overwrite"
  // rule in checkVaultStatus prevented a re-lock), the pane would show decrypted
  // state with a null key (S7). Call lock() to force LOCKED and unmount the pane.
  // lock() zeroes wrappedKeyRef/salt and setEncryptionKey(null) — bare setVaultStatus
  // alone would leave those refs resident (S11/S13).
  useEffect(() => {
    const handlePageshow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // If the key is null but status still reads UNLOCKED, force a full lock transition.
      if (secretKeyRef.current === null && vaultStatus === VAULT_STATUS.UNLOCKED) {
        lock();
      }
    };
    window.addEventListener("pageshow", handlePageshow);
    return () => window.removeEventListener("pageshow", handlePageshow);
  }, [vaultStatus, lock]);

  // ─── Setup (first time) ───────────────────────────────────────

  const setup = useCallback(async (passphrase: string) => {
    // 1. Generate secret key and account salt
    const secretKey = generateSecretKey();
    const accountSalt = generateAccountSalt();

    // 2. Derive wrapping key from passphrase
    const wrappingKey = await deriveWrappingKey(passphrase, accountSalt);

    // 3. Wrap (encrypt) the secret key
    const wrappedKey = await wrapSecretKey(secretKey, wrappingKey);

    // 4. Derive encryption key and auth key
    const encKey = await deriveEncryptionKey(secretKey);
    const authKey = await deriveAuthKey(secretKey);

    // 5. Compute auth hash for server verification
    const authHash = await computeAuthHash(authKey);

    // 6. Create verification artifact
    const artifact = await createVerificationArtifact(encKey);

    // 7. Compute passphrase verifier for server-side identity confirmation
    const verifierHash = await computePassphraseVerifier(passphrase, accountSalt);

    // 8. Generate ECDH key pair and encrypt private key with domain-separated ecdhWrappingKey
    const ecdhKeyPair = await generateECDHKeyPair();
    const ecdhPubJwk = await exportPublicKey(ecdhKeyPair.publicKey);
    const ecdhPrivBytes = await exportPrivateKey(ecdhKeyPair.privateKey);
    const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);
    const ecdhEncrypted = await encryptBinary(
      ecdhPrivBytes.buffer.slice(
        ecdhPrivBytes.byteOffset,
        ecdhPrivBytes.byteOffset + ecdhPrivBytes.byteLength,
      ) as ArrayBuffer,
      ecdhWrapKey,
    );

    // 9. Send to server
    const res = await fetchApi(API_PATH.VAULT_SETUP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encryptedSecretKey: wrappedKey.ciphertext,
        secretKeyIv: wrappedKey.iv,
        secretKeyAuthTag: wrappedKey.authTag,
        accountSalt: hexEncode(accountSalt),
        authHash,
        verifierHash,
        verificationArtifact: artifact,
        ecdhPublicKey: ecdhPubJwk,
        encryptedEcdhPrivateKey: hexEncode(ecdhEncrypted.ciphertext),
        ecdhPrivateKeyIv: ecdhEncrypted.iv,
        ecdhPrivateKeyAuthTag: ecdhEncrypted.authTag,
      }),
    });

    if (!res.ok) {
      ecdhPrivBytes.fill(0);
      const err = await res.json();
      throw new Error(err.error || "Setup failed");
    }

    // 10. Store secretKey, keyVersion, accountSalt, wrappedKey, ECDH keys, and encryption key in memory
    secretKeyRef.current = new Uint8Array(secretKey);
    keyVersionRef.current = 1;
    accountSaltRef.current = accountSalt;
    wrappedKeyRef.current = { ciphertext: wrappedKey.ciphertext, iv: wrappedKey.iv, authTag: wrappedKey.authTag };
    ecdhPrivateKeyBytesRef.current = new Uint8Array(ecdhPrivBytes);
    ecdhPublicKeyJwkRef.current = ecdhPubJwk;
    ecdhPrivBytes.fill(0);
    secretKey.fill(0);
    setEncryptionKey(encKey);
    setVaultStatus(VAULT_STATUS.UNLOCKED);
  }, []);

  // ─── Unlock ───────────────────────────────────────────────────

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    try {
      // 1. Fetch encrypted secret key + verification artifact (session-protected)
      const dataRes = await fetchApi(API_PATH.VAULT_UNLOCK_DATA);
      if (!dataRes.ok) {
        if (dataRes.status === 401) {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }
        await throwIfUnlockDataLocked(dataRes);
        return false;
      }
      const vaultData = await dataRes.json();

      if (!vaultData.accountSalt) return false;
      const accountSalt = hexDecode(vaultData.accountSalt);

      // 2. Derive wrapping key from passphrase + accountSalt
      const wrappingKey = await deriveWrappingKey(passphrase, accountSalt);

      // 3. Try to unwrap (decrypt) the secret key — fails if wrong passphrase
      let secretKey: Uint8Array;
      try {
        secretKey = await unwrapSecretKey(
          {
            ciphertext: vaultData.encryptedSecretKey,
            iv: vaultData.secretKeyIv,
            authTag: vaultData.secretKeyAuthTag,
          },
          wrappingKey
        );
      } catch {
        // Passphrase is wrong — notify server for lockout tracking.
        // Network failures are swallowed (VaultUnlockError propagates for lockout UI).
        try { await notifyUnlockFailure(); } catch (e) { if (e instanceof VaultUnlockError) throw e; }
        return false;
      }

      // 4. Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          secretKey.fill(0);
          try { await notifyUnlockFailure(); } catch (e) { if (e instanceof VaultUnlockError) throw e; }
          return false;
        }
      }

      // 5. Compute auth hash and verify with server (for logging/rate-limiting)
      const authKey = await deriveAuthKey(secretKey);
      const authHash = await computeAuthHash(authKey);

      // 5b. Compute verifier for backfill if server doesn't have one yet
      const unlockBody: Record<string, string> = { authHash };
      if (!vaultData.hasVerifier) {
        unlockBody.verifierHash = await computePassphraseVerifier(
          passphrase,
          accountSalt
        );
      }

      const unlockRes = await fetchApi(API_PATH.VAULT_UNLOCK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unlockBody),
      });

      if (!unlockRes.ok) {
        const body = await unlockRes.json().catch(() => ({}));
        if (body.error) {
          throw new VaultUnlockError(body.error, body.lockedUntil);
        }
        return false;
      }

      // 6. Store secretKey, keyVersion, accountSalt, wrappedKey for EA auto-confirm and changePassphrase
      secretKeyRef.current = new Uint8Array(secretKey);
      keyVersionRef.current = vaultData.keyVersion ?? 1;
      accountSaltRef.current = accountSalt;
      wrappedKeyRef.current = {
        ciphertext: vaultData.encryptedSecretKey,
        iv: vaultData.secretKeyIv,
        authTag: vaultData.secretKeyAuthTag,
      };

      // 6b. Restore ECDH private key if available (team E2E)
      if (vaultData.encryptedEcdhPrivateKey && vaultData.ecdhPrivateKeyIv && vaultData.ecdhPrivateKeyAuthTag) {
        try {
          const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);
          const ecdhPrivDecrypted = await decryptBinary(
            {
              ciphertext: hexDecode(vaultData.encryptedEcdhPrivateKey),
              iv: vaultData.ecdhPrivateKeyIv,
              authTag: vaultData.ecdhPrivateKeyAuthTag,
            },
            ecdhWrapKey,
          );
          ecdhPrivateKeyBytesRef.current = new Uint8Array(ecdhPrivDecrypted);
          ecdhPublicKeyJwkRef.current = vaultData.ecdhPublicKey ?? null;
        } catch {
          // ECDH restoration failure is non-fatal — team features will be unavailable
        }
      }

      secretKey.fill(0);

      // 7. Auto-confirm pending emergency access grants (async nonblocking)
      const userId = session?.user?.id;
      if (userId && secretKeyRef.current) {
        const sk = new Uint8Array(secretKeyRef.current);
        confirmPendingEmergencyGrants(sk, userId, keyVersionRef.current)
          .catch(() => {})
          .finally(() => sk.fill(0));
      }

      // 8. Store encryption key in memory
      setEncryptionKey(encKey);
      setVaultStatus(VAULT_STATUS.UNLOCKED);

      return true;
    } catch (err) {
      if (err instanceof VaultUnlockError) throw err;
      return false;
    }
  }, [session?.user?.id]);

  // ─── Unlock with Passkey (PRF) ───────────────────────────────

  const unlockWithPasskey = useCallback(async (): Promise<boolean> => {
    try {
      // 1. Fetch vault data and WebAuthn options in parallel
      const [dataRes, optionsRes] = await Promise.all([
        fetchApi(API_PATH.VAULT_UNLOCK_DATA),
        fetchApi(API_PATH.WEBAUTHN_AUTHENTICATE_OPTIONS, { method: "POST" }),
      ]);

      if (!dataRes.ok || !optionsRes.ok) {
        if (dataRes.status === 401 || optionsRes.status === 401) {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }
        if (!dataRes.ok) await throwIfUnlockDataLocked(dataRes);
        return false;
      }

      const vaultData = await dataRes.json();
      const { options, prfSalt } = await optionsRes.json();

      // A02-8 F1: post-A02-8 the server may return `prfSalt: null` when every
      // PRF-capable credential is v2 (per-credential salts are carried inside
      // `options.extensions.prf.evalByCredential`). The legacy guard
      // `if (!prfSalt) return false;` short-circuited those users — silently
      // breaking PRF auto-unlock. Accept the path when EITHER the top-level
      // v1 salt OR the server-built extensions are present.
      const serverBuiltPrf =
        typeof options?.extensions?.prf === "object" && options.extensions.prf !== null;
      if ((!prfSalt && !serverBuiltPrf) || !vaultData.accountSalt) return false;

      // 2. Perform WebAuthn authentication with PRF extension. The browser
      // client prefers `options.extensions.prf` when present and falls back
      // to the `prfSalt` param otherwise.
      const { responseJSON, prfOutput } = await startPasskeyAuthentication(
        options,
        prfSalt ?? undefined,
      );

      if (!prfOutput) {
        // PRF not supported by this credential/browser
        return false;
      }

      // 3. Verify with server — get PRF-encrypted secretKey
      const verifyRes = await fetchApi(API_PATH.WEBAUTHN_AUTHENTICATE_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: responseJSON }),
      });

      if (!verifyRes.ok) return false;

      const verifyData = await verifyRes.json();
      if (!verifyData.verified || !verifyData.prf) {
        prfOutput.fill(0);
        return false;
      }

      // 4. Unwrap secretKey using PRF output
      let secretKey: Uint8Array;
      try {
        secretKey = await unwrapSecretKeyWithPrf(
          {
            ciphertext: verifyData.prf.prfEncryptedSecretKey,
            iv: verifyData.prf.prfSecretKeyIv,
            authTag: verifyData.prf.prfSecretKeyAuthTag,
          },
          prfOutput,
        );
      } finally {
        prfOutput.fill(0);
      }

      // 5. Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          secretKey.fill(0);
          return false;
        }
      }

      // 6. Compute auth hash and verify with server
      const authKey = await deriveAuthKey(secretKey);
      const authHash = await computeAuthHash(authKey);

      const unlockRes = await fetchApi(API_PATH.VAULT_UNLOCK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authHash }),
      });

      if (!unlockRes.ok) {
        const body = await unlockRes.json().catch(() => ({}));
        if (body.error) {
          throw new VaultUnlockError(body.error, body.lockedUntil);
        }
        secretKey.fill(0);
        return false;
      }

      // 7. Store refs (same as passphrase unlock)
      const accountSalt = hexDecode(vaultData.accountSalt);
      secretKeyRef.current = new Uint8Array(secretKey);
      keyVersionRef.current = vaultData.keyVersion ?? 1;
      accountSaltRef.current = accountSalt;
      wrappedKeyRef.current = {
        ciphertext: vaultData.encryptedSecretKey,
        iv: vaultData.secretKeyIv,
        authTag: vaultData.secretKeyAuthTag,
      };

      // 7b. Restore ECDH private key if available
      if (vaultData.encryptedEcdhPrivateKey && vaultData.ecdhPrivateKeyIv && vaultData.ecdhPrivateKeyAuthTag) {
        try {
          const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);
          const ecdhPrivDecrypted = await decryptBinary(
            {
              ciphertext: hexDecode(vaultData.encryptedEcdhPrivateKey),
              iv: vaultData.ecdhPrivateKeyIv,
              authTag: vaultData.ecdhPrivateKeyAuthTag,
            },
            ecdhWrapKey,
          );
          ecdhPrivateKeyBytesRef.current = new Uint8Array(ecdhPrivDecrypted);
          ecdhPublicKeyJwkRef.current = vaultData.ecdhPublicKey ?? null;
        } catch {
          // ECDH restoration failure is non-fatal
        }
      }

      secretKey.fill(0);

      // 8. Auto-confirm pending emergency access grants
      const userId = session?.user?.id;
      if (userId && secretKeyRef.current) {
        const sk = new Uint8Array(secretKeyRef.current);
        confirmPendingEmergencyGrants(sk, userId, keyVersionRef.current)
          .catch(() => {})
          .finally(() => sk.fill(0));
      }

      // 9. Set unlocked
      setEncryptionKey(encKey);
      setVaultStatus(VAULT_STATUS.UNLOCKED);

      return true;
    } catch (err) {
      if (err instanceof VaultUnlockError) throw err;
      // User cancelled WebAuthn dialog — not an error
      if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
        return false;
      }
      return false;
    }
  }, [session?.user?.id]);

  // ─── Unlock with stored PRF (single-ceremony sign-in flow) ──────

  /**
   * Unlock the vault using PRF output handed off in-memory during sign-in.
   * This avoids a second authenticator interaction (e.g., QR code scan) by
   * reusing the PRF output obtained during the sign-in ceremony.
   */
  const unlockWithStoredPrf = useCallback(async (): Promise<boolean> => {
    // PRF material is handed off in-memory (not sessionStorage) and cleared on
    // read; absent after a full reload → caller falls back to manual unlock.
    const handoff = takePrf();
    if (!handoff) return false;

    // Single finally zeroizes both the PRF output and the unwrapped secret key
    // on every exit (early returns and throws alike); the PRF buffer's
    // ownership was transferred to us by takePrf above. secretKey is hoisted
    // here so the finally covers the post-derivation throw paths too.
    const prfOutput = handoff.prfOutput;
    let secretKey: Uint8Array | null = null;
    try {
      const prfData = handoff.prfData;

      // Fetch vault data
      const dataRes = await fetchApi(API_PATH.VAULT_UNLOCK_DATA);
      if (!dataRes.ok) {
        if (dataRes.status === 401) {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }
        await throwIfUnlockDataLocked(dataRes);
        return false;
      }
      const vaultData = await dataRes.json();
      if (!vaultData.accountSalt) return false;

      // Unwrap secretKey using PRF output (no WebAuthn ceremony needed)
      secretKey = await unwrapSecretKeyWithPrf(
        {
          ciphertext: prfData.prfEncryptedSecretKey,
          iv: prfData.prfSecretKeyIv,
          authTag: prfData.prfSecretKeyAuthTag,
        },
        prfOutput,
      );

      // Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          return false;
        }
      }

      // Compute auth hash and verify with server
      const authKey = await deriveAuthKey(secretKey);
      const authHash = await computeAuthHash(authKey);

      const unlockRes = await fetchApi(API_PATH.VAULT_UNLOCK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authHash }),
      });

      if (!unlockRes.ok) {
        const body = await unlockRes.json().catch(() => ({}));
        if (body.error) {
          throw new VaultUnlockError(body.error, body.lockedUntil);
        }
        return false;
      }

      // Store refs (same as passkey unlock)
      const accountSalt = hexDecode(vaultData.accountSalt);
      secretKeyRef.current = new Uint8Array(secretKey);
      keyVersionRef.current = vaultData.keyVersion ?? 1;
      accountSaltRef.current = accountSalt;
      wrappedKeyRef.current = {
        ciphertext: vaultData.encryptedSecretKey,
        iv: vaultData.secretKeyIv,
        authTag: vaultData.secretKeyAuthTag,
      };

      // Restore ECDH private key if available
      if (vaultData.encryptedEcdhPrivateKey && vaultData.ecdhPrivateKeyIv && vaultData.ecdhPrivateKeyAuthTag) {
        try {
          const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);
          const ecdhPrivDecrypted = await decryptBinary(
            {
              ciphertext: hexDecode(vaultData.encryptedEcdhPrivateKey),
              iv: vaultData.ecdhPrivateKeyIv,
              authTag: vaultData.ecdhPrivateKeyAuthTag,
            },
            ecdhWrapKey,
          );
          ecdhPrivateKeyBytesRef.current = new Uint8Array(ecdhPrivDecrypted);
          ecdhPublicKeyJwkRef.current = vaultData.ecdhPublicKey ?? null;
        } catch {
          // ECDH restoration failure is non-fatal
        }
      }

      // Auto-confirm pending emergency access grants
      const userId = session?.user?.id;
      if (userId && secretKeyRef.current) {
        const sk = new Uint8Array(secretKeyRef.current);
        confirmPendingEmergencyGrants(sk, userId, keyVersionRef.current)
          .catch(() => {})
          .finally(() => sk.fill(0));
      }

      // Set unlocked
      setEncryptionKey(encKey);
      setVaultStatus(VAULT_STATUS.UNLOCKED);

      return true;
    } catch (err) {
      if (err instanceof VaultUnlockError) throw err;
      return false;
    } finally {
      prfOutput.fill(0);
      secretKey?.fill(0);
    }
  }, [session?.user?.id]);

  // ─── Change Passphrase ────────────────────────────────────────

  const changePassphrase = useCallback(
    async (currentPassphrase: string, newPassphrase: string) => {
      if (!accountSaltRef.current || !secretKeyRef.current) {
        throw new Error("Vault must be unlocked to change passphrase");
      }

      // 1. Compute current verifier for server-side identity confirmation
      const currentVerifierHash = await computePassphraseVerifier(
        currentPassphrase,
        accountSaltRef.current
      );

      // 2. Generate new account salt
      const newAccountSalt = generateAccountSalt();

      // 3. Derive new wrapping key and re-wrap secretKey
      const newWrappingKey = await deriveWrappingKey(newPassphrase, newAccountSalt);
      const rewrapped = await wrapSecretKey(secretKeyRef.current, newWrappingKey);

      // 4. Compute new verifier
      const newVerifierHash = await computePassphraseVerifier(
        newPassphrase,
        newAccountSalt
      );

      // 5. Send to server
      const res = await fetchApi(API_PATH.VAULT_CHANGE_PASSPHRASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentVerifierHash,
          encryptedSecretKey: rewrapped.ciphertext,
          secretKeyIv: rewrapped.iv,
          secretKeyAuthTag: rewrapped.authTag,
          accountSalt: hexEncode(newAccountSalt),
          newVerifierHash,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw err;
      }

      // 6. Update local accountSalt and wrappedKey (secretKey unchanged)
      accountSaltRef.current = newAccountSalt;
      wrappedKeyRef.current = {
        ciphertext: rewrapped.ciphertext,
        iv: rewrapped.iv,
        authTag: rewrapped.authTag,
      };
    },
    []
  );

  // ─── Rotate Key ───────────────────────────────────────────────

  const rotateKey = useCallback(
    async (
      passphrase: string,
      onProgress?: (progress: { phase: "migrating" | "rewrapping" | "committing" | "entries" | "history", current: number, total: number }) => void,
    ) => {
      if (!secretKeyRef.current || !accountSaltRef.current || !encryptionKey) {
        throw new Error("Vault must be unlocked to rotate key");
      }

      const oldEncryptionKey = encryptionKey;
      const oldKeyVersion = keyVersionRef.current;

      // 1. Compute currentAuthHash for server-side identity verification
      const currentAuthKey = await deriveAuthKey(secretKeyRef.current);
      const currentAuthHash = await computeAuthHash(currentAuthKey);

      // 2. Fetch rotation data (entries, history, attachment CEK data, mode-0 IDs)
      const dataRes = await fetchApi(API_PATH.VAULT_ROTATE_KEY_DATA);
      if (!dataRes.ok) {
        const err = await dataRes.json().catch(() => ({}));
        throw err;
      }
      const rotationData = await dataRes.json() as {
        entries: Array<{
          id: string;
          encryptedBlob: string;
          blobIv: string;
          blobAuthTag: string;
          encryptedOverview: string;
          overviewIv: string;
          overviewAuthTag: string;
          keyVersion: number;
          aadVersion: number;
        }>;
        historyEntries: Array<{
          id: string;
          entryId: string;
          encryptedBlob: string;
          blobIv: string;
          blobAuthTag: string;
          keyVersion: number;
          aadVersion: number;
        }>;
        mode2Attachments: Array<{
          id: string;
          entryId: string;
          cekEncrypted: string | null; // base64
          cekIv: string | null;
          cekAuthTag: string | null;
          cekKeyVersion: number | null;
          cekWrapAadVersion: number | null;
        }>;
        mode0Attachments: Array<{ id: string; entryId: string }>;
        mode0AttachmentsOverflow: boolean;
      };

      // 3. Migrate all mode-0 attachments to mode-2 using OLD encryption key.
      //    Loop until mode0Attachments is empty (handles overflow pagination).
      let legacyAttachmentsMigrated = 0;
      let currentRotationData = rotationData;
      while (currentRotationData.mode0Attachments.length > 0) {
        const total = currentRotationData.mode0Attachments.length;
        for (let i = 0; i < total; i++) {
          const { id: attId, entryId } = currentRotationData.mode0Attachments[i];
          onProgress?.({ phase: "migrating", current: i, total });

          // GET the legacy attachment.
          const attRes = await fetchApi(apiPath.passwordAttachmentById(entryId, attId));
          if (!attRes.ok) {
            throw new Error(`MIGRATE_FETCH_FAILED:${attId}`);
          }
          const att = (await attRes.json()) as {
            encryptedData: string; // base64
            iv: string;
            authTag: string;
            encryptionMode: number;
          };
          if (att.encryptionMode !== 0) {
            // Concurrent migration — skip; next iteration will pick up the
            // updated mode0Attachments list.
            continue;
          }

          // Decode stored ciphertext bytes for body decrypt + hash binding.
          const storedBinary = atob(att.encryptedData);
          const storedBytes = new Uint8Array(storedBinary.length);
          for (let j = 0; j < storedBinary.length; j++) {
            storedBytes[j] = storedBinary.charCodeAt(j);
          }

          // I5.4 — bind the migration request to the exact stored bytes the
          // client decrypted (defense against session-attacker body replacement).
          const hashBuf = await crypto.subtle.digest("SHA-256", storedBytes);
          const hashBytes = new Uint8Array(hashBuf);
          let oldEncryptedDataHash = "";
          for (const b of hashBytes) {
            oldEncryptedDataHash += b.toString(16).padStart(2, "0");
          }

          // Decrypt body with OLD encryption key + data AAD.
          const dataAad = buildAttachmentAAD(entryId, attId);
          const plaintext = await decryptBinary(
            { ciphertext: storedBytes, iv: att.iv, authTag: att.authTag },
            oldEncryptionKey,
            dataAad,
          );

          // Generate fresh CEK, encrypt body under CEK + same data AAD.
          const cekKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"],
          );
          const newBody = await encryptBinary(plaintext, cekKey, dataAad);

          // Wrap CEK under OLD encryption key + wrap AAD with OLD keyVersion.
          const cekRaw = await crypto.subtle.exportKey("raw", cekKey);
          const wrapAad = buildAttachmentCekWrapAAD(entryId, attId, oldKeyVersion, 1);
          const wrappedCek = await encryptBinary(
            cekRaw,
            oldEncryptionKey,
            wrapAad,
          );
          // I8.2 zeroize exported raw CEK bytes.
          new Uint8Array(cekRaw).fill(0);

          // Base64-encode CEK ciphertext and body ciphertext for the JSON PUT.
          const encodeB64 = (bytes: Uint8Array): string => {
            let s = "";
            for (const byte of bytes) s += String.fromCharCode(byte);
            return btoa(s);
          };

          const migrateRes = await fetchApi(
            apiPath.passwordAttachmentMigrate(entryId, attId),
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                oldEncryptedDataHash,
                encryptedData: encodeB64(newBody.ciphertext),
                iv: newBody.iv,
                authTag: newBody.authTag,
                cekEncrypted: encodeB64(wrappedCek.ciphertext),
                cekIv: wrappedCek.iv,
                cekAuthTag: wrappedCek.authTag,
                cekKeyVersion: oldKeyVersion,
                cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
              }),
            },
          );
          if (!migrateRes.ok) {
            const err = (await migrateRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? `MIGRATE_FAILED:${attId}`);
          }
          legacyAttachmentsMigrated += 1;
          onProgress?.({ phase: "migrating", current: i + 1, total });
        }

        // Re-fetch rotation data to pick up next page (overflow) and observe
        // any newly mode-2 rows for the rewrap step.
        const refetchRes = await fetchApi(API_PATH.VAULT_ROTATE_KEY_DATA);
        if (!refetchRes.ok) {
          throw new Error("ROTATE_DATA_REFETCH_FAILED");
        }
        currentRotationData = (await refetchRes.json()) as typeof currentRotationData;
      }

      const { entries, historyEntries } = rotationData;

      // 4. Generate new secret key and derive new encryption key
      const newSecretKey = generateSecretKey();
      const newEncKey = await deriveEncryptionKey(newSecretKey);
      const newKeyVersion = oldKeyVersion + 1;

      // 5. Re-encrypt entries: decrypt with OLD encryptionKey, re-encrypt with newEncKey
      const userId = session?.user?.id;
      const totalEntries = entries.length;
      const reencryptedEntries = [];
      for (let i = 0; i < totalEntries; i++) {
        const entry = entries[i];
        onProgress?.({ phase: "entries", current: i, total: totalEntries });

        const blobAad = entry.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, entry.id, VAULT_TYPE.BLOB)
          : undefined;
        const overviewAad = entry.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, entry.id, VAULT_TYPE.OVERVIEW)
          : undefined;

        const decryptedBlob = await decryptData(
          {
            ciphertext: entry.encryptedBlob,
            iv: entry.blobIv,
            authTag: entry.blobAuthTag,
          },
          oldEncryptionKey,
          blobAad,
        );
        const newBlob = await encryptData(decryptedBlob, newEncKey, blobAad);

        const decryptedOverview = await decryptData(
          {
            ciphertext: entry.encryptedOverview,
            iv: entry.overviewIv,
            authTag: entry.overviewAuthTag,
          },
          oldEncryptionKey,
          overviewAad,
        );
        const newOverview = await encryptData(decryptedOverview, newEncKey, overviewAad);

        reencryptedEntries.push({
          id: entry.id,
          encryptedBlob: newBlob,
          encryptedOverview: newOverview,
          aadVersion: entry.aadVersion,
        });
      }
      onProgress?.({ phase: "entries", current: totalEntries, total: totalEntries });

      // 6. Re-encrypt history entries
      const totalHistory = historyEntries.length;
      const reencryptedHistory = [];
      for (let i = 0; i < totalHistory; i++) {
        const histEntry = historyEntries[i];
        onProgress?.({ phase: "history", current: i, total: totalHistory });

        // History blobs are verbatim snapshots of the entry blob, sealed with
        // the entry AAD (PV "blob"). Re-encrypt under the same AAD so the
        // rotated row stays decryptable by the history view.
        const histAad = histEntry.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, histEntry.entryId, VAULT_TYPE.BLOB)
          : undefined;

        const decryptedBlob = await decryptData(
          {
            ciphertext: histEntry.encryptedBlob,
            iv: histEntry.blobIv,
            authTag: histEntry.blobAuthTag,
          },
          oldEncryptionKey,
          histAad,
        );
        const newBlob = await encryptData(decryptedBlob, newEncKey, histAad);

        reencryptedHistory.push({
          id: histEntry.id,
          encryptedBlob: newBlob,
          aadVersion: histEntry.aadVersion,
        });
      }
      onProgress?.({ phase: "history", current: totalHistory, total: totalHistory });

      // 7. Rewrap mode-2 attachment CEKs with new encryption key
      onProgress?.({ phase: "rewrapping", current: 0, total: currentRotationData.mode2Attachments.length });
      const attachmentCekRewraps = [];
      for (let i = 0; i < currentRotationData.mode2Attachments.length; i++) {
        const att = currentRotationData.mode2Attachments[i];
        if (
          att.cekEncrypted == null ||
          att.cekIv == null ||
          att.cekAuthTag == null ||
          att.cekKeyVersion == null ||
          att.cekWrapAadVersion == null
        ) {
          // Inconsistent CEK data — skip; server will reject at ATTACHMENT_KEY_MANIFEST_MISMATCH
          continue;
        }
        // S3 defense: a server-side attacker with DB write access could flip
        // cekWrapAadVersion below the floor; reject before AES-GCM unwrap so
        // the client never accepts a downgraded format. Plan I8a.3 / S3.
        if (att.cekWrapAadVersion < MIN_ACCEPTED_CEK_WRAP_AAD_VERSION) {
          continue;
        }

        // Unwrap CEK with old encryptionKey
        const oldWrapAad = buildAttachmentCekWrapAAD(att.entryId, att.id, att.cekKeyVersion, att.cekWrapAadVersion);
        const binaryStr = atob(att.cekEncrypted);
        const cekEncBytes = new Uint8Array(binaryStr.length);
        for (let j = 0; j < binaryStr.length; j++) {
          cekEncBytes[j] = binaryStr.charCodeAt(j);
        }
        const cekRaw = await decryptBinary(
          { ciphertext: cekEncBytes, iv: att.cekIv, authTag: att.cekAuthTag },
          oldEncryptionKey,
          oldWrapAad,
        );

        // Rewrap CEK with new encryptionKey (I8.1: manual AES-GCM, not wrapKey)
        const newWrapAad = buildAttachmentCekWrapAAD(att.entryId, att.id, newKeyVersion, 1);
        const newWrappedCek = await encryptBinary(cekRaw, newEncKey, newWrapAad);

        // Zeroize raw CEK after use (I8.2)
        new Uint8Array(cekRaw).fill(0);

        // Encode new wrapped CEK as base64
        let newCekB64 = "";
        for (const byte of newWrappedCek.ciphertext) {
          newCekB64 += String.fromCharCode(byte);
        }
        newCekB64 = btoa(newCekB64);

        attachmentCekRewraps.push({
          id: att.id,
          cekEncrypted: newCekB64,
          cekIv: newWrappedCek.iv,
          cekAuthTag: newWrappedCek.authTag,
          cekKeyVersion: newKeyVersion,
          cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
        });

        onProgress?.({ phase: "rewrapping", current: i + 1, total: currentRotationData.mode2Attachments.length });
      }

      // 8. Re-wrap ECDH private key with new secret key
      const ecdhWrapKey = await deriveEcdhWrappingKey(newSecretKey);
      if (!ecdhPrivateKeyBytesRef.current) {
        throw new Error("ECDH_KEY_UNAVAILABLE");
      }
      const ecdhSourceBytes = ecdhPrivateKeyBytesRef.current;
      const ecdhEncrypted = await encryptBinary(
        ecdhSourceBytes.buffer.slice(
          ecdhSourceBytes.byteOffset,
          ecdhSourceBytes.byteOffset + ecdhSourceBytes.byteLength,
        ) as ArrayBuffer,
        ecdhWrapKey,
      );

      // 9. Generate new accountSalt, derive wrapping key, wrap new secretKey
      const newAccountSalt = generateAccountSalt();
      const newWrappingKey = await deriveWrappingKey(passphrase, newAccountSalt);
      const newWrappedKey = await wrapSecretKey(newSecretKey, newWrappingKey);

      // 10. Compute new auth credentials, verifier, and verification artifact
      const newAuthKey = await deriveAuthKey(newSecretKey);
      const newAuthHash = await computeAuthHash(newAuthKey);
      const newVerifierHash = await computePassphraseVerifier(passphrase, newAccountSalt);
      const verificationArtifact = await createVerificationArtifact(newEncKey);

      // 11. POST to /api/vault/rotate-key
      onProgress?.({ phase: "committing", current: 0, total: 1 });
      const res = await fetchApi(API_PATH.VAULT_ROTATE_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentAuthHash,
          encryptedSecretKey: newWrappedKey.ciphertext,
          secretKeyIv: newWrappedKey.iv,
          secretKeyAuthTag: newWrappedKey.authTag,
          accountSalt: hexEncode(newAccountSalt),
          newAuthHash,
          newVerifierHash,
          verificationArtifact,
          entries: reencryptedEntries,
          historyEntries: reencryptedHistory,
          encryptedEcdhPrivateKey: hexEncode(ecdhEncrypted.ciphertext),
          ecdhPrivateKeyIv: ecdhEncrypted.iv,
          ecdhPrivateKeyAuthTag: ecdhEncrypted.authTag,
          attachmentCekRewraps,
          legacyAttachmentsMigratedThisCycle: legacyAttachmentsMigrated,
        }),
      });

      if (!res.ok) {
        newSecretKey.fill(0);
        const err = await res.json().catch(() => ({}));
        throw err;
      }

      const result = await res.json();

      // 12. Update in-memory state
      secretKeyRef.current = new Uint8Array(newSecretKey);
      keyVersionRef.current = result.keyVersion ?? keyVersionRef.current + 1;
      accountSaltRef.current = newAccountSalt;
      wrappedKeyRef.current = {
        ciphertext: newWrappedKey.ciphertext,
        iv: newWrappedKey.iv,
        authTag: newWrappedKey.authTag,
      };
      // ecdhPrivateKeyBytesRef remains valid — private key bytes did not change.
      newSecretKey.fill(0);
      setEncryptionKey(newEncKey);
      // The dialog uses these counts to surface operator banners.
      const effects = (result as { rotationEffects?: RotationEffects }).rotationEffects;
      if (effects) {
        return { ...effects, legacyAttachmentsMigrated };
      }
      return null;
    },
    [encryptionKey, session?.user?.id],
  );

  const verifyPassphrase = useCallback(async (passphrase: string): Promise<boolean> => {
    if (!accountSaltRef.current || !wrappedKeyRef.current) return false;
    try {
      const wrappingKey = await deriveWrappingKey(passphrase, accountSaltRef.current);
      const sk = await unwrapSecretKey(wrappedKeyRef.current, wrappingKey);
      sk.fill(0);
      return true;
    } catch {
      return false;
    }
  }, []);

  const getSecretKey = useCallback(() => {
    return secretKeyRef.current ? new Uint8Array(secretKeyRef.current) : null;
  }, []);

  const getAccountSalt = useCallback(() => {
    return accountSaltRef.current ? new Uint8Array(accountSaltRef.current) : null;
  }, []);

  const getKeyVersion = useCallback(() => keyVersionRef.current, []);

  const getEcdhPrivateKeyBytes = useCallback(() => {
    return ecdhPrivateKeyBytesRef.current ? new Uint8Array(ecdhPrivateKeyBytesRef.current) : null;
  }, []);

  const getEcdhPublicKeyJwk = useCallback(() => {
    return ecdhPublicKeyJwkRef.current;
  }, []);

  const getUserId = useCallback(() => session?.user?.id ?? null, [session]);

  return (
    <VaultContext.Provider
      value={{
        status: vaultStatus,
        encryptionKey,
        userId: session?.user?.id ?? null,
        hasRecoveryKey,
        recoveryKeyInvalidated,
        tenantPolicy,
        unlock,
        unlockWithPasskey,
        unlockWithStoredPrf,
        lock,
        setup,
        changePassphrase,
        rotateKey,
        verifyPassphrase,
        getSecretKey,
        getAccountSalt,
        getKeyVersion,
        setHasRecoveryKey,
        getEcdhPrivateKeyBytes,
        getEcdhPublicKeyJwk,
      }}
    >
      <AutoLockProvider
        vaultStatus={vaultStatus}
        lock={lock}
        autoLockMinutes={autoLockMinutes}
      >
        <EmergencyAccessProvider
          vaultStatus={vaultStatus}
          getSecretKey={getSecretKey}
          keyVersion={keyVersionRef.current}
          userId={session?.user?.id}
        >
          <TeamVaultProvider
            getEcdhPrivateKeyBytes={getEcdhPrivateKeyBytes}
            getUserId={getUserId}
            vaultUnlocked={vaultStatus === VAULT_STATUS.UNLOCKED}
          >
            {children}
          </TeamVaultProvider>
        </EmergencyAccessProvider>
      </AutoLockProvider>
    </VaultContext.Provider>
  );
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error("useVault must be used within a VaultProvider");
  }
  return ctx;
}
