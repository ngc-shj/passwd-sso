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
  createVerificationArtifact,
  verifyKey,
  type EncryptedData,
} from "./crypto-client";
import { createKeyEscrow } from "./crypto-emergency";

// ─── Types ──────────────────────────────────────────────────────

export type VaultStatus = "loading" | "locked" | "unlocked" | "setup-required";

interface VaultContextValue {
  status: VaultStatus;
  encryptionKey: CryptoKey | null;
  unlock: (passphrase: string) => Promise<boolean>;
  lock: () => void;
  setup: (passphrase: string) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

// ─── Constants ──────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const HIDDEN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes when tab hidden
const ACTIVITY_CHECK_INTERVAL_MS = 30_000; // check every 30 seconds
const EA_CONFIRM_INTERVAL_MS = 2 * 60 * 1000; // check pending EA grants every 2 minutes

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

async function confirmPendingEmergencyGrants(secretKey: Uint8Array, ownerId: string): Promise<void> {
  const res = await fetch("/api/emergency-access/pending-confirmations");
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
      });
      await fetch(`/api/emergency-access/${grant.id}/confirm`, {
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
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("loading");
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const secretKeyRef = useRef<Uint8Array | null>(null);
  const lastActivityRef = useRef(Date.now());
  const hiddenAtRef = useRef<number | null>(null);

  // ─── Fetch vault status on session load ───────────────────────

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !session?.user) {
      if (sessionStatus === "unauthenticated") {
        setVaultStatus("locked");
      }
      return;
    }

    async function checkVaultStatus() {
      try {
        const res = await fetch("/api/vault/status");
        if (!res.ok) {
          setVaultStatus("locked");
          return;
        }
        const data = await res.json();
        setVaultStatus(data.setupRequired ? "setup-required" : "locked");
      } catch {
        setVaultStatus("locked");
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
    setEncryptionKey(null);
    setVaultStatus((prev) =>
      prev === "unlocked" ? "locked" : prev
    );
  }, []);

  useEffect(() => {
    if (vaultStatus !== "unlocked") return;

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
      const sinceActivity = now - lastActivityRef.current;

      // Lock after inactivity timeout
      if (sinceActivity > INACTIVITY_TIMEOUT_MS) {
        lock();
        return;
      }

      // Lock after hidden timeout
      if (hiddenAtRef.current && now - hiddenAtRef.current > HIDDEN_TIMEOUT_MS) {
        lock();
      }
    };

    window.addEventListener("mousemove", updateActivity);
    window.addEventListener("keydown", updateActivity);
    window.addEventListener("click", updateActivity);
    window.addEventListener("touchstart", updateActivity);
    document.addEventListener("visibilitychange", handleVisibility);

    const intervalId = setInterval(checkInactivity, ACTIVITY_CHECK_INTERVAL_MS);

    return () => {
      window.removeEventListener("mousemove", updateActivity);
      window.removeEventListener("keydown", updateActivity);
      window.removeEventListener("click", updateActivity);
      window.removeEventListener("touchstart", updateActivity);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(intervalId);
    };
  }, [vaultStatus, lock]);

  // ─── Periodic EA auto-confirm ────────────────────────────────

  useEffect(() => {
    if (vaultStatus !== "unlocked" || !session?.user?.id) return;

    const userId = session.user.id;
    let inFlight = false;

    const run = () => {
      if (inFlight || !secretKeyRef.current) return;
      inFlight = true;
      confirmPendingEmergencyGrants(secretKeyRef.current, userId)
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
    const zeroSecretKey = () => {
      if (secretKeyRef.current) {
        secretKeyRef.current.fill(0);
        secretKeyRef.current = null;
      }
    };
    window.addEventListener("pagehide", zeroSecretKey);
    return () => {
      window.removeEventListener("pagehide", zeroSecretKey);
      zeroSecretKey(); // also zero on unmount
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

    // 7. Send to server
    const res = await fetch("/api/vault/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encryptedSecretKey: wrappedKey.ciphertext,
        secretKeyIv: wrappedKey.iv,
        secretKeyAuthTag: wrappedKey.authTag,
        accountSalt: hexEncode(accountSalt),
        authHash,
        verificationArtifact: artifact,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Setup failed");
    }

    // 8. Store encryption key in memory
    setEncryptionKey(encKey);
    setVaultStatus("unlocked");
    lastActivityRef.current = Date.now();
  }, []);

  // ─── Unlock ───────────────────────────────────────────────────

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    try {
      // 1. Fetch encrypted secret key + verification artifact (session-protected)
      const dataRes = await fetch("/api/vault/unlock/data");
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
        return false; // wrong passphrase
      }

      // 4. Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          secretKey.fill(0);
          return false;
        }
      }

      // 5. Compute auth hash and verify with server (for logging/rate-limiting)
      const authKey = await deriveAuthKey(secretKey);
      const authHash = await computeAuthHash(authKey);
      await fetch("/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authHash }),
      });

      // 6. Store secretKey for periodic EA auto-confirm, zero the local copy
      secretKeyRef.current = new Uint8Array(secretKey);
      secretKey.fill(0);

      // 7. Auto-confirm pending emergency access grants (fire-and-forget)
      const userId = session?.user?.id;
      if (userId && secretKeyRef.current) {
        confirmPendingEmergencyGrants(secretKeyRef.current, userId).catch(() => {
          // Silently ignore — emergency access confirmation is best-effort
        });
      }

      // 8. Store encryption key in memory
      setEncryptionKey(encKey);
      setVaultStatus("unlocked");
      lastActivityRef.current = Date.now();

      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <VaultContext.Provider
      value={{
        status: vaultStatus,
        encryptionKey,
        unlock,
        lock,
        setup,
      }}
    >
      {children}
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
