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
} from "./crypto-client";
import { createKeyEscrow } from "./crypto-emergency";
import { TeamVaultProvider } from "./team-vault-context";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  deriveEcdhWrappingKey,
} from "./crypto-team";
import { API_PATH, apiPath, VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";

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
  const res = await fetch(API_PATH.VAULT_UNLOCK, {
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
  lock: () => void;
  setup: (passphrase: string) => Promise<void>;
  changePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
  verifyPassphrase: (passphrase: string) => Promise<boolean>;
  getSecretKey: () => Uint8Array | null;
  getAccountSalt: () => Uint8Array | null;
  setHasRecoveryKey: (value: boolean) => void;
  getEcdhPrivateKeyBytes: () => Uint8Array | null;
  getEcdhPublicKeyJwk: () => string | null;
}

const VaultContext = createContext<VaultContextValue | null>(null);

// ─── Constants ──────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const HIDDEN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes when tab hidden
const ACTIVITY_CHECK_INTERVAL_MS = 30_000; // check every 30 seconds
const EA_CONFIRM_INTERVAL_MS = 2 * 60 * 1000; // check pending EA grants every 2 minutes
const SKIP_BEFOREUNLOAD_ONCE_KEY = "psso:skip-beforeunload-once";
const ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY =
  "psso:allow-beforeunload-while-ext-connect";

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function hexEncode(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Emergency Access Auto-Confirm ──────────────────────────

async function confirmPendingEmergencyGrants(secretKey: Uint8Array, ownerId: string, keyVersion: number): Promise<void> {
  const res = await fetch(API_PATH.EMERGENCY_PENDING_CONFIRMATIONS);
  if (!res.ok) return;
  const grants: Array<{
    id: string;
    granteeId: string;
    granteePublicKey: string;
  }> = await res.json();

  for (const grant of grants) {
    try {
      const escrow = await createKeyEscrow(secretKey, grant.granteePublicKey, {
        grantId: grant.id,
        ownerId,
        granteeId: grant.granteeId,
        keyVersion,
      });
      await fetch(apiPath.emergencyConfirm(grant.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(escrow),
      });
    } catch {
      // Skip individual grant failures
    }
  }
}

// ─── Provider ───────────────────────────────────────────────────

export function VaultProvider({ children }: { children: ReactNode }) {
  const { data: session, status: sessionStatus } = useSession();
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>(VAULT_STATUS.LOADING);
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(false);
  const secretKeyRef = useRef<Uint8Array | null>(null);
  const keyVersionRef = useRef<number>(0);
  const accountSaltRef = useRef<Uint8Array | null>(null);
  const wrappedKeyRef = useRef<{ ciphertext: string; iv: string; authTag: string } | null>(null);
  const lastActivityRef = useRef(Date.now());
  const hiddenAtRef = useRef<number | null>(null);
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
        const res = await fetch(API_PATH.VAULT_STATUS);
        if (!res.ok) {
          setVaultStatus((prev) => prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED);
          return;
        }
        const data = await res.json();
        setHasRecoveryKey(!!data.hasRecoveryKey);
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

  // ─── Auto-lock on inactivity ──────────────────────────────────

  const lock = useCallback(() => {
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

  useEffect(() => {
    if (vaultStatus !== VAULT_STATUS.UNLOCKED) return;

    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        hiddenAtRef.current = null;
        updateActivity();
      }
    };

    const checkInactivity = () => {
      const now = Date.now();

      // When tab is hidden, only check hidden timeout (not inactivity).
      // The user may be active in other tabs — that's not "inactivity".
      if (document.hidden) {
        if (hiddenAtRef.current && now - hiddenAtRef.current > HIDDEN_TIMEOUT_MS) {
          lock();
        }
        return;
      }

      // Tab is visible — check inactivity timeout
      const sinceActivity = now - lastActivityRef.current;
      if (sinceActivity > INACTIVITY_TIMEOUT_MS) {
        lock();
      }
    };

    window.addEventListener("mousemove", updateActivity);
    window.addEventListener("keydown", updateActivity);
    window.addEventListener("click", updateActivity);
    window.addEventListener("scroll", updateActivity, true);
    window.addEventListener("wheel", updateActivity, { passive: true });
    window.addEventListener("touchstart", updateActivity);
    document.addEventListener("visibilitychange", handleVisibility);

    const intervalId = setInterval(checkInactivity, ACTIVITY_CHECK_INTERVAL_MS);

    return () => {
      window.removeEventListener("mousemove", updateActivity);
      window.removeEventListener("keydown", updateActivity);
      window.removeEventListener("click", updateActivity);
      window.removeEventListener("scroll", updateActivity, true);
      window.removeEventListener("wheel", updateActivity);
      window.removeEventListener("touchstart", updateActivity);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(intervalId);
    };
  }, [vaultStatus, lock]);

  // ─── Guard against accidental full reload while vault is unlocked ────────

  useEffect(() => {
    if (vaultStatus !== VAULT_STATUS.UNLOCKED) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Allow a single intentional close flow (e.g. extension connect "Close tab")
      try {
        if (sessionStorage.getItem(SKIP_BEFOREUNLOAD_ONCE_KEY) === "1") {
          sessionStorage.removeItem(SKIP_BEFOREUNLOAD_ONCE_KEY);
          return;
        }
        // Allow tab close while extension-connect completion screen is shown.
        if (sessionStorage.getItem(ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY) === "1") {
          return;
        }
      } catch {
        // Ignore storage access failures and keep safe default behavior.
      }
      e.preventDefault();
      e.returnValue = "";
    };

    const handleReloadShortcut = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isReloadKey = key === "f5" || ((e.metaKey || e.ctrlKey) && key === "r");
      if (!isReloadKey) return;
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("keydown", handleReloadShortcut, true);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("keydown", handleReloadShortcut, true);
    };
  }, [vaultStatus]);

  // ─── Periodic EA auto-confirm ────────────────────────────────

  useEffect(() => {
    if (vaultStatus !== VAULT_STATUS.UNLOCKED || !session?.user?.id) return;

    const userId = session.user.id;
    let inFlight = false;

    const run = () => {
      if (inFlight || !secretKeyRef.current) return;
      inFlight = true;
      confirmPendingEmergencyGrants(secretKeyRef.current, userId, keyVersionRef.current)
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };

    const intervalId = setInterval(run, EA_CONFIRM_INTERVAL_MS);

    // Re-check on tab focus and network reconnect
    const handleVisible = () => { if (!document.hidden) run(); };
    const handleOnline = () => run();
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("online", handleOnline);
    };
  }, [vaultStatus, session?.user?.id]);

  // ─── SecretKey cleanup on unmount / page unload ─────────────

  useEffect(() => {
    const zeroSensitiveKeys = () => {
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
    const res = await fetch(API_PATH.VAULT_SETUP, {
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
    lastActivityRef.current = Date.now();
  }, []);

  // ─── Unlock ───────────────────────────────────────────────────

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    try {
      // 1. Fetch encrypted secret key + verification artifact (session-protected)
      const dataRes = await fetch(API_PATH.VAULT_UNLOCK_DATA);
      if (!dataRes.ok) return false;
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

      const unlockRes = await fetch(API_PATH.VAULT_UNLOCK, {
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

      // 7. Auto-confirm pending emergency access grants (fire-and-forget)
      const userId = session?.user?.id;
      if (userId && secretKeyRef.current) {
        confirmPendingEmergencyGrants(secretKeyRef.current, userId, keyVersionRef.current).catch(() => {
          // Silently ignore — emergency access confirmation is best-effort
        });
      }

      // 8. Store encryption key in memory
      setEncryptionKey(encKey);
      setVaultStatus(VAULT_STATUS.UNLOCKED);
      lastActivityRef.current = Date.now();

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
      const res = await fetch(API_PATH.VAULT_CHANGE_PASSPHRASE, {
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
        lock,
        setup,
        changePassphrase,
        verifyPassphrase,
        getSecretKey,
        getAccountSalt,
        setHasRecoveryKey,
        getEcdhPrivateKeyBytes,
        getEcdhPublicKeyJwk,
      }}
    >
      <TeamVaultProvider
        getEcdhPrivateKeyBytes={getEcdhPrivateKeyBytes}
        getUserId={getUserId}
        vaultUnlocked={vaultStatus === VAULT_STATUS.UNLOCKED}
      >
        {children}
      </TeamVaultProvider>
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
