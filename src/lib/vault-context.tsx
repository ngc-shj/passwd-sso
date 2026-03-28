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
} from "./crypto-client";
import { TeamVaultProvider } from "./team-vault-context";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  deriveEcdhWrappingKey,
} from "./crypto-team";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { API_PATH, VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";
import { API_ERROR } from "@/lib/api-error-codes";
import { fetchApi } from "@/lib/url-helpers";
import { hexDecode, hexEncode } from "./crypto-utils";
import {
  startPasskeyAuthentication,
  unwrapSecretKeyWithPrf,
} from "./webauthn-client";
import { AutoLockProvider } from "./auto-lock-context";
import { EmergencyAccessProvider, confirmPendingEmergencyGrants } from "./emergency-access-context";

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

interface VaultContextValue {
  status: VaultStatus;
  encryptionKey: CryptoKey | null;
  userId: string | null;
  hasRecoveryKey: boolean;
  unlock: (passphrase: string) => Promise<boolean>;
  unlockWithPasskey: () => Promise<boolean>;
  unlockWithStoredPrf: () => Promise<boolean>;
  lock: () => void;
  setup: (passphrase: string) => Promise<void>;
  changePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
  rotateKey: (passphrase: string, onProgress?: (phase: string, current: number, total: number) => void) => Promise<void>;
  verifyPassphrase: (passphrase: string) => Promise<boolean>;
  getSecretKey: () => Uint8Array | null;
  getAccountSalt: () => Uint8Array | null;
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
  const [autoLockMinutes, setAutoLockMinutes] = useState<number | null>(null);
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
        // Apply tenant-configured vault auto-lock timeout
        if (data.vaultAutoLockMinutes != null && data.vaultAutoLockMinutes > 0) {
          setAutoLockMinutes(data.vaultAutoLockMinutes);
        }
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
    }, 10_000);

    // Second timeout: if still LOADING after 15s, show lock screen
    const fallbackTimer = setTimeout(() => {
      setVaultStatus((prev) =>
        prev === VAULT_STATUS.LOADING ? VAULT_STATUS.LOCKED : prev,
      );
    }, 15_000);

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(fallbackTimer);
    };
  }, [vaultStatus]);

  const lock = useCallback(() => {
    // Revoke all delegation sessions (best-effort, survives page unload)
    fetch("/api/vault/delegation", { method: "DELETE", keepalive: true }).catch(() => {});
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
      fetch("/api/vault/delegation", { method: "DELETE", keepalive: true }).catch(() => {});
      if (secretKeyRef.current) {
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
        return false;
      }

      const vaultData = await dataRes.json();
      const { options, prfSalt } = await optionsRes.json();

      if (!prfSalt || !vaultData.accountSalt) return false;

      // 2. Perform WebAuthn authentication with PRF extension
      const { responseJSON, prfOutput } = await startPasskeyAuthentication(
        options,
        prfSalt,
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
   * Unlock the vault using PRF output stored in sessionStorage during sign-in.
   * This avoids a second authenticator interaction (e.g., QR code scan) by
   * reusing the PRF output obtained during the sign-in ceremony.
   */
  const unlockWithStoredPrf = useCallback(async (): Promise<boolean> => {
    const prfOutputHex = sessionStorage.getItem("psso:prf-output");
    const prfDataStr = sessionStorage.getItem("psso:prf-data");

    // Always clean up immediately
    sessionStorage.removeItem("psso:prf-output");
    sessionStorage.removeItem("psso:prf-data");

    if (!prfOutputHex || !prfDataStr) return false;

    try {
      const prfOutput = hexDecode(prfOutputHex);
      const prfData = JSON.parse(prfDataStr);

      // Fetch vault data
      const dataRes = await fetchApi(API_PATH.VAULT_UNLOCK_DATA);
      if (!dataRes.ok) {
        if (dataRes.status === 401) {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }
        return false;
      }
      const vaultData = await dataRes.json();
      if (!vaultData.accountSalt) return false;

      // Unwrap secretKey using PRF output (no WebAuthn ceremony needed)
      let secretKey: Uint8Array;
      try {
        secretKey = await unwrapSecretKeyWithPrf(
          {
            ciphertext: prfData.prfEncryptedSecretKey,
            iv: prfData.prfSecretKeyIv,
            authTag: prfData.prfSecretKeyAuthTag,
          },
          prfOutput,
        );
      } finally {
        prfOutput.fill(0);
      }

      // Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          secretKey.fill(0);
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
        secretKey.fill(0);
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

      secretKey.fill(0);

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
      onProgress?: (phase: string, current: number, total: number) => void,
    ) => {
      if (!secretKeyRef.current || !accountSaltRef.current || !encryptionKey) {
        throw new Error("Vault must be unlocked to rotate key");
      }

      // 1. Compute currentAuthHash for server-side identity verification
      const currentAuthKey = await deriveAuthKey(secretKeyRef.current);
      const currentAuthHash = await computeAuthHash(currentAuthKey);

      // 2. Fetch all entries and history via GET /api/vault/rotate-key/data
      const dataRes = await fetchApi(API_PATH.VAULT_ROTATE_KEY_DATA);
      if (!dataRes.ok) {
        const err = await dataRes.json().catch(() => ({}));
        throw err;
      }
      const { entries, historyEntries } = await dataRes.json();

      // 3. Generate new secret key
      const newSecretKey = generateSecretKey();

      // 4. Derive new encryption key
      const newEncKey = await deriveEncryptionKey(newSecretKey);

      // 5. Re-encrypt entries: decrypt with current encryptionKey, re-encrypt with newEncKey
      const userId = session?.user?.id;
      const totalEntries = entries.length;
      const reencryptedEntries = [];
      for (let i = 0; i < totalEntries; i++) {
        const entry = entries[i];
        onProgress?.("entries", i, totalEntries);

        const entryAad = entry.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, entry.id)
          : undefined;

        const decryptedBlob = await decryptData(
          {
            ciphertext: entry.encryptedBlob,
            iv: entry.blobIv,
            authTag: entry.blobAuthTag,
          },
          encryptionKey!,
          entryAad,
        );
        const newBlob = await encryptData(decryptedBlob, newEncKey, entryAad);

        const decryptedOverview = await decryptData(
          {
            ciphertext: entry.encryptedOverview,
            iv: entry.overviewIv,
            authTag: entry.overviewAuthTag,
          },
          encryptionKey!,
          entryAad,
        );
        const newOverview = await encryptData(decryptedOverview, newEncKey, entryAad);

        reencryptedEntries.push({
          id: entry.id,
          encryptedBlob: newBlob,
          encryptedOverview: newOverview,
          aadVersion: entry.aadVersion,
        });
      }
      onProgress?.("entries", totalEntries, totalEntries);

      // 6. Re-encrypt history entries
      const totalHistory = historyEntries.length;
      const reencryptedHistory = [];
      for (let i = 0; i < totalHistory; i++) {
        const histEntry = historyEntries[i];
        onProgress?.("history", i, totalHistory);

        // History entries use the parent entry's AAD (entryId, not histEntry.id)
        const histAad = histEntry.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, histEntry.entryId)
          : undefined;

        const decryptedBlob = await decryptData(
          {
            ciphertext: histEntry.encryptedBlob,
            iv: histEntry.blobIv,
            authTag: histEntry.blobAuthTag,
          },
          encryptionKey!,
          histAad,
        );
        const newBlob = await encryptData(decryptedBlob, newEncKey, histAad);

        reencryptedHistory.push({
          id: histEntry.id,
          encryptedBlob: newBlob,
          aadVersion: histEntry.aadVersion,
        });
      }
      onProgress?.("history", totalHistory, totalHistory);

      // 7. Re-wrap ECDH private key with new secret key
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

      // 8. Generate new accountSalt, derive wrapping key, wrap new secretKey
      const newAccountSalt = generateAccountSalt();
      const newWrappingKey = await deriveWrappingKey(passphrase, newAccountSalt);
      const newWrappedKey = await wrapSecretKey(newSecretKey, newWrappingKey);

      // 9. Compute new auth credentials, verifier, and verification artifact
      const newAuthKey = await deriveAuthKey(newSecretKey);
      const newAuthHash = await computeAuthHash(newAuthKey);
      const newVerifierHash = await computePassphraseVerifier(passphrase, newAccountSalt);
      const verificationArtifact = await createVerificationArtifact(newEncKey);

      // 10. POST to /api/vault/rotate-key
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
        }),
      });

      if (!res.ok) {
        newSecretKey.fill(0);
        const err = await res.json().catch(() => ({}));
        throw err;
      }

      const result = await res.json();

      // 11. Update in-memory state
      secretKeyRef.current = new Uint8Array(newSecretKey);
      keyVersionRef.current = result.keyVersion ?? keyVersionRef.current + 1;
      accountSaltRef.current = newAccountSalt;
      wrappedKeyRef.current = {
        ciphertext: newWrappedKey.ciphertext,
        iv: newWrappedKey.iv,
        authTag: newWrappedKey.authTag,
      };
      // ecdhPrivateKeyBytesRef remains valid — the private key bytes themselves
      // did not change, only the wrapping key changed.
      newSecretKey.fill(0);
      setEncryptionKey(newEncKey);
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
