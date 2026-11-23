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
  deriveAuthKeyBytes,
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
import { API_PATH, apiPath, VAULT_STATUS, ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseJsonBodyOnce, readApiErrorBody } from "@/lib/http/read-api-error-body";
import { fetchApi } from "@/lib/url-helpers";
import { hexDecode, hexEncode } from "../crypto/crypto-utils";
import { takePrf } from "@/lib/auth/prf-handoff";
import { readPasskeyOptions, readPrfData } from "@/lib/auth/webauthn/passkey-response";
import {
  startPasskeyAuthentication,
  unwrapSecretKeyWithPrf,
} from "../auth/webauthn/webauthn-client";
import { AutoLockProvider } from "./auto-lock-context";
import { EmergencyAccessProvider, confirmPendingEmergencyGrants } from "../emergency-access/emergency-access-context";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { PRE_ROUTE_AND_PRE_TX_REFUSALS } from "./pre-commit-refusals";

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
 * Thrown by `changePassphrase` / `rotateKey` when the server may or may not
 * have committed the key change and the client cannot tell which. The vault
 * has already been locked: keeping the pre-change key material would leave
 * the old passphrase unlocking a committed passphrase change, or keep writing
 * under a key whose rows a committed rotation replaced. The next unlock reads
 * the authoritative wrap from the server.
 */
export class VaultChangeOutcomeUnknownError extends Error {
  constructor() {
    super("VAULT_CHANGE_OUTCOME_UNKNOWN");
    this.name = "VaultChangeOutcomeUnknownError";
  }
}

/**
 * Thrown by `changePassphrase` / `rotateKey` when the server refused because
 * another writer had already moved the vault wrap (a change in another tab or
 * on another device). This request wrote nothing, but the local salt, wrap and
 * key are stale — kept, they would let `verifyPassphrase` accept the old
 * passphrase — so the vault has already been locked. The next unlock reads the
 * authoritative wrap from the server.
 */
export class VaultChangedElsewhereError extends Error {
  constructor(public readonly code: string) {
    super("VAULT_CHANGED_ELSEWHERE");
    this.name = "VaultChangedElsewhereError";
  }
}

// Codes that prove a key-changing POST was refused before anything committed:
// the shared PRE_ROUTE_AND_PRE_TX_REFUSALS plus each route's own.
//
// change-passphrase: none of its own, so it checks the shared set directly. Its
// only post-commit refusal is SESSION_INVALIDATE_FAILED, which the caller
// handles as committed.
// rotate-key: ATTACHMENT_MIGRATION_INCOMPLETE, ATTACHMENT_KEY_MANIFEST_MISMATCH,
// ATTACHMENT_INCONSISTENT_VERSION, ENTRY_COUNT_MISMATCH are mapped from errors
// thrown inside the transaction, which roll it back.
// Deliberately absent: INTERNAL_ERROR. rotate-key also returns it for two
// in-transaction errors, but a 500 does not tell the client the write rolled
// back, and treating it as unknown costs only one unlock.
// Also absent: each route's compare-and-swap refusal (WRAP_MOVED_ELSEWHERE_*
// below), which is pre-commit too but leaves the local state stale.
const ROTATE_KEY_REFUSALS: ReadonlySet<string> = new Set([
  ...PRE_ROUTE_AND_PRE_TX_REFUSALS,
  API_ERROR.ATTACHMENT_MIGRATION_INCOMPLETE,
  API_ERROR.ATTACHMENT_KEY_MANIFEST_MISMATCH,
  API_ERROR.ATTACHMENT_INCONSISTENT_VERSION,
  API_ERROR.ENTRY_COUNT_MISMATCH,
]);

// The compare-and-swap refusal of each route: the CAS matched no row, so
// nothing was written, but only because another writer moved the wrap first.
// rotate-key maps its RotationCasConflictError to KEY_VERSION_MISMATCH.
const WRAP_MOVED_ELSEWHERE_CHANGE_PASSPHRASE = API_ERROR.VAULT_WRAP_CONFLICT;
const WRAP_MOVED_ELSEWHERE_ROTATE_KEY = API_ERROR.KEY_VERSION_MISMATCH;

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
    const body = await readApiErrorBody(res);
    if (body) {
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

/**
 * `rotateKey`'s result when the server committed the rotation but its response
 * body could not be read. The client has already switched to the new key (it
 * sent every value it holds), but the rotation's side-effects are unknown — in
 * particular whether the account's other sessions and tokens were revoked — so
 * the caller must say so rather than report a clean rotation.
 */
export const ROTATION_EFFECTS_UNAVAILABLE = "ROTATION_EFFECTS_UNAVAILABLE";

/**
 * `rotateKey`'s result when the server committed the rotation but the vault
 * was locked (auto-lock, the user) while the request was in flight. The new
 * key material was not installed into the locked vault; the next unlock reads
 * the committed wrap. The caller must not report the vault as usable.
 */
export const ROTATION_COMMITTED_VAULT_LOCKED = "ROTATION_COMMITTED_VAULT_LOCKED";

/**
 * `rotateKey`'s result when the vault was locked while the rotation was being
 * prepared (re-encrypting entries, before the rotate POST). Nothing was sent:
 * the server still holds the old key and wrap, and the rotation must be started
 * again after unlocking.
 */
export const ROTATION_NOT_STARTED_VAULT_LOCKED = "ROTATION_NOT_STARTED_VAULT_LOCKED";

/**
 * `invalidationFailed`: the server committed the new wrap but could not sign
 * out the account's other sessions (SESSION_INVALIDATE_FAILED).
 */
export interface PassphraseChangeEffects {
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
  changePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<PassphraseChangeEffects>;
  rotateKey: (
    passphrase: string,
    onProgress?: (progress: { phase: "migrating" | "rewrapping" | "committing" | "entries" | "history", current: number, total: number }) => void,
  ) => Promise<
    | RotationEffects
    | typeof ROTATION_EFFECTS_UNAVAILABLE
    | typeof ROTATION_COMMITTED_VAULT_LOCKED
    | typeof ROTATION_NOT_STARTED_VAULT_LOCKED
    | null
  >;
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
  const sessionUserId = session?.user?.id;
  // Server verdicts carried on the session (passkeyBlocked is computed on the
  // server clock). While either holds, the proxy refuses every gated call, so
  // the root providers' background polling is suspended.
  const passkeyGated = !!(session?.user?.passkeyBlocked || session?.user?.passkeyStateDegraded);
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>(() =>
    sessionStatus === "unauthenticated" ? VAULT_STATUS.LOCKED : VAULT_STATUS.LOADING,
  );
  const [prevSessionStatus, setPrevSessionStatus] = useState(sessionStatus);
  if (sessionStatus !== prevSessionStatus) {
    setPrevSessionStatus(sessionStatus);
    if (sessionStatus === "unauthenticated") {
      setVaultStatus(VAULT_STATUS.LOCKED);
    }
  }
  // A passkey-gated session never fetches the vault status (see the status
  // effect), so LOADING settles to LOCKED here, during render, before the
  // LOADING retry/fallback timers can arm. UNLOCKED and SETUP_REQUIRED are
  // left alone. The verdict is the server's `passkeyBlocked` — never
  // re-derived on the client from the raw fields.
  if (passkeyGated && sessionStatus === "authenticated" && vaultStatus === VAULT_STATUS.LOADING) {
    setVaultStatus(VAULT_STATUS.LOCKED);
  }
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
  // The ref serves callbacks; the state is what render passes down. Write
  // both through commitKeyVersion so they cannot drift apart.
  const [keyVersion, setKeyVersion] = useState(0);
  const commitKeyVersion = useCallback((version: number) => {
    keyVersionRef.current = version;
    setKeyVersion(version);
  }, []);
  const accountSaltRef = useRef<Uint8Array | null>(null);
  const wrappedKeyRef = useRef<{ ciphertext: string; iv: string; authTag: string } | null>(null);
  // ECDH key pair for team E2E encryption
  const ecdhPrivateKeyBytesRef = useRef<Uint8Array | null>(null);
  const ecdhPublicKeyJwkRef = useRef<string | null>(null);
  // Bumped whenever the key material is dropped (lock, page hide). A key change
  // whose request was in flight across a bump must not install its result.
  // Every path that drops key material must bump it (lock() and the
  // zeroSensitiveKeys effect today).
  const lockEpochRef = useRef(0);

  // ─── Fetch vault status on session load ───────────────────────

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !session?.user) return;

    // A passkey-blocked or degraded session is refused by the proxy on every
    // vault endpoint, so the status call is skipped on every run of this
    // effect (it re-runs on each session update). LOADING has already been
    // settled to LOCKED during render (above), and an existing UNLOCKED state
    // is left for the auto-lock timer.
    if (session.user.passkeyBlocked || session.user.passkeyStateDegraded) return;

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
        // Apply tenant-configured vault auto-lock timeout. Propagate null too
        // (not only positive values) so that clearing an explicit value resets
        // the provider to its default timer — otherwise a longer stale value
        // would keep enforcing past the intended boundary after the tenant
        // switches back to the default.
        setAutoLockMinutes(
          data.vaultAutoLockMinutes != null && data.vaultAutoLockMinutes > 0
            ? data.vaultAutoLockMinutes
            : null,
        );
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
    lockEpochRef.current += 1;
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
      lockEpochRef.current += 1;
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
    let ecdhPrivBytes: Uint8Array | null = null;
    let authKeyBytes: Uint8Array | null = null;
    try {
      const accountSalt = generateAccountSalt();

      // 2. Derive wrapping key from passphrase
      const wrappingKey = await deriveWrappingKey(passphrase, accountSalt);

      // 3. Wrap (encrypt) the secret key
      const wrappedKey = await wrapSecretKey(secretKey, wrappingKey);

      // 4. Derive encryption key and auth key
      const encKey = await deriveEncryptionKey(secretKey);
      authKeyBytes = await deriveAuthKeyBytes(secretKey);

      // 5. Compute auth hash for server verification
      const authHash = await computeAuthHash(authKeyBytes);

      // 6. Create verification artifact
      const artifact = await createVerificationArtifact(encKey);

      // 7. Compute passphrase verifier for server-side identity confirmation
      const verifierHash = await computePassphraseVerifier(passphrase, accountSalt);

      // 8. Generate ECDH key pair and encrypt private key with domain-separated ecdhWrappingKey
      const ecdhKeyPair = await generateECDHKeyPair();
      const ecdhPubJwk = await exportPublicKey(ecdhKeyPair.publicKey);
      ecdhPrivBytes = await exportPrivateKey(ecdhKeyPair.privateKey);
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
        const err = await readApiErrorBody(res);
        throw new Error(err?.error || "Setup failed");
      }

      // 10. Store secretKey, keyVersion, accountSalt, wrappedKey, ECDH keys, and encryption key in memory
      secretKeyRef.current = new Uint8Array(secretKey);
      commitKeyVersion(1);
      accountSaltRef.current = accountSalt;
      wrappedKeyRef.current = { ciphertext: wrappedKey.ciphertext, iv: wrappedKey.iv, authTag: wrappedKey.authTag };
      ecdhPrivateKeyBytesRef.current = new Uint8Array(ecdhPrivBytes);
      ecdhPublicKeyJwkRef.current = ecdhPubJwk;
      setEncryptionKey(encKey);
      setVaultStatus(VAULT_STATUS.UNLOCKED);
    } finally {
      // The success path copied both into refs; a rejected or refused POST, or
      // a throw while deriving, must not leave them in memory.
      secretKey.fill(0);
      ecdhPrivBytes?.fill(0);
      authKeyBytes?.fill(0);
    }
  }, [commitKeyVersion]);

  // ─── Unlock ───────────────────────────────────────────────────

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    // One finally zeroes the unwrapped key and the auth key bytes on every
    // exit — a refused or rejected unlock POST included; the success path
    // copied the secret key into secretKeyRef.
    let secretKey: Uint8Array | null = null;
    let authKeyBytes: Uint8Array | null = null;
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
      let unwrapped: Uint8Array;
      try {
        unwrapped = await unwrapSecretKey(
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
      secretKey = unwrapped;

      // 4. Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          try { await notifyUnlockFailure(); } catch (e) { if (e instanceof VaultUnlockError) throw e; }
          return false;
        }
      }

      // 5. Compute auth hash and verify with server (for logging/rate-limiting)
      authKeyBytes = await deriveAuthKeyBytes(secretKey);
      const authHash = await computeAuthHash(authKeyBytes);

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
        const body = await readApiErrorBody(unlockRes);
        if (body) {
          throw new VaultUnlockError(body.error, body.lockedUntil);
        }
        return false;
      }

      // 6. Store secretKey, keyVersion, accountSalt, wrappedKey for EA auto-confirm and changePassphrase
      secretKeyRef.current = new Uint8Array(secretKey);
      commitKeyVersion(vaultData.keyVersion ?? 1);
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

      // 7. Auto-confirm pending emergency access grants (async nonblocking)
      const userId = sessionUserId;
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
    } finally {
      secretKey?.fill(0);
      authKeyBytes?.fill(0);
    }
  }, [sessionUserId, commitKeyVersion]);

  // ─── Unlock with Passkey (PRF) ───────────────────────────────

  const unlockWithPasskey = useCallback(async (): Promise<boolean> => {
    // One finally zeroes the PRF output, the unwrapped key and the auth key
    // bytes on every exit (a refused or rejected verify or unlock POST
    // included); the success path copied the secret key into secretKeyRef.
    let prfOutput: Uint8Array | null = null;
    let secretKey: Uint8Array | null = null;
    let authKeyBytes: Uint8Array | null = null;
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
      // An unreadable or malformed options body offers no ceremony: the
      // unlock fails like any other unusable options response.
      const passkeyOptions = readPasskeyOptions(await parseJsonBodyOnce(optionsRes));
      if (!passkeyOptions) return false;
      const { options, challengeId, prfSalt } = passkeyOptions;

      // A02-8 F1: post-A02-8 the server may return `prfSalt: null` when every
      // PRF-capable credential is v2 (per-credential salts are carried inside
      // `options.extensions.prf.evalByCredential`). The legacy guard
      // `if (!prfSalt) return false;` short-circuited those users — silently
      // breaking PRF auto-unlock. Accept the path when EITHER the top-level
      // v1 salt OR the server-built extensions are present.
      const extensions = options.extensions;
      const serverBuiltPrf =
        typeof extensions === "object" && extensions !== null &&
        "prf" in extensions && typeof extensions.prf === "object" && extensions.prf !== null;
      if ((!prfSalt && !serverBuiltPrf) || !vaultData.accountSalt) return false;

      // 2. Perform WebAuthn authentication with PRF extension. The browser
      // client prefers `options.extensions.prf` when present and falls back
      // to the `prfSalt` param otherwise.
      const ceremony = await startPasskeyAuthentication(options, prfSalt);
      const { responseJSON } = ceremony;
      prfOutput = ceremony.prfOutput;

      if (!prfOutput) {
        // PRF not supported by this credential/browser
        return false;
      }

      // 3. Verify with server — get PRF-encrypted secretKey
      const verifyRes = await fetchApi(API_PATH.WEBAUTHN_AUTHENTICATE_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: responseJSON, challengeId }),
      });

      if (!verifyRes.ok) return false;

      // An unreadable body carries no PRF wrapping: the unlock fails like a
      // verify that returned none.
      const verifyData = await parseJsonBodyOnce(verifyRes);
      const verified =
        typeof verifyData === "object" && verifyData !== null &&
        "verified" in verifyData && verifyData.verified === true;
      const prfData = readPrfData(verifyData);
      if (!verified || !prfData) return false;

      // 4. Unwrap secretKey using PRF output
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

      // 5. Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) return false;
      }

      // 6. Compute auth hash and verify with server
      authKeyBytes = await deriveAuthKeyBytes(secretKey);
      const authHash = await computeAuthHash(authKeyBytes);

      const unlockRes = await fetchApi(API_PATH.VAULT_UNLOCK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authHash }),
      });

      if (!unlockRes.ok) {
        const body = await readApiErrorBody(unlockRes);
        if (body) {
          throw new VaultUnlockError(body.error, body.lockedUntil);
        }
        return false;
      }

      // 7. Store refs (same as passphrase unlock)
      const accountSalt = hexDecode(vaultData.accountSalt);
      secretKeyRef.current = new Uint8Array(secretKey);
      commitKeyVersion(vaultData.keyVersion ?? 1);
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

      // 8. Auto-confirm pending emergency access grants
      const userId = sessionUserId;
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
    } finally {
      prfOutput?.fill(0);
      secretKey?.fill(0);
      authKeyBytes?.fill(0);
    }
  }, [sessionUserId, commitKeyVersion]);

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
    let authKeyBytes: Uint8Array | null = null;
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
      authKeyBytes = await deriveAuthKeyBytes(secretKey);
      const authHash = await computeAuthHash(authKeyBytes);

      const unlockRes = await fetchApi(API_PATH.VAULT_UNLOCK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authHash }),
      });

      if (!unlockRes.ok) {
        const body = await readApiErrorBody(unlockRes);
        if (body) {
          throw new VaultUnlockError(body.error, body.lockedUntil);
        }
        return false;
      }

      // Store refs (same as passkey unlock)
      const accountSalt = hexDecode(vaultData.accountSalt);
      secretKeyRef.current = new Uint8Array(secretKey);
      commitKeyVersion(vaultData.keyVersion ?? 1);
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
      const userId = sessionUserId;
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
      authKeyBytes?.fill(0);
    }
  }, [sessionUserId, commitKeyVersion]);

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
      const lockEpoch = lockEpochRef.current;
      let res: Response;
      try {
        res = await fetchApi(API_PATH.VAULT_CHANGE_PASSPHRASE, {
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
      } catch {
        lock();
        throw new VaultChangeOutcomeUnknownError();
      }

      // SESSION_INVALIDATE_FAILED is returned after the new wrap committed,
      // so it must still update the local refs below or they go stale.
      let invalidationFailed = false;
      if (!res.ok) {
        const err = await readApiErrorBody(res);
        if (err?.error === WRAP_MOVED_ELSEWHERE_CHANGE_PASSPHRASE) {
          lock();
          throw new VaultChangedElsewhereError(err.error);
        }
        if (err?.error !== API_ERROR.SESSION_INVALIDATE_FAILED) {
          if (!err || !PRE_ROUTE_AND_PRE_TX_REFUSALS.has(err.error)) {
            lock();
            throw new VaultChangeOutcomeUnknownError();
          }
          throw err;
        }
        invalidationFailed = true;
      }

      // 6. Update local accountSalt and wrappedKey (secretKey unchanged) —
      // unless the vault was locked while the request was in flight: the next
      // unlock reads the committed wrap, and a locked vault holds no wrap.
      if (lockEpochRef.current !== lockEpoch) return { invalidationFailed };
      accountSaltRef.current = newAccountSalt;
      wrappedKeyRef.current = {
        ciphertext: rewrapped.ciphertext,
        iv: rewrapped.iv,
        authTag: rewrapped.authTag,
      };
      return { invalidationFailed };
    },
    [lock]
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
      // A lock at any point from here on drops the key material this rotation
      // started from; see the checks before and after the rotate POST.
      const lockEpoch = lockEpochRef.current;

      // The new wrap and verifier are derived from the typed passphrase, so a
      // typo would become the new passphrase. Refuse it here before
      // re-encrypting anything; the server's verifier check is the authority
      // (a tab whose state predates a change elsewhere still passes this one).
      if (!(await verifyPassphrase(passphrase))) {
        throw { error: API_ERROR.INVALID_PASSPHRASE };
      }

      // 1. Compute currentAuthHash (proof of the current secret key) and
      // currentVerifierHash (proof of the typed passphrase, under the current
      // salt) for server-side verification
      const currentAuthKeyBytes = await deriveAuthKeyBytes(secretKeyRef.current);
      let currentAuthHash: string;
      try {
        currentAuthHash = await computeAuthHash(currentAuthKeyBytes);
      } finally {
        currentAuthKeyBytes.fill(0);
      }
      const currentVerifierHash = await computePassphraseVerifier(passphrase, accountSaltRef.current);

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
          if (att.encryptionMode !== ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY) {
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
            const err = await readApiErrorBody(migrateRes);
            throw new Error(err?.error ?? `MIGRATE_FAILED:${attId}`);
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
      try {
        const newEncKey = await deriveEncryptionKey(newSecretKey);
        const newKeyVersion = oldKeyVersion + 1;

        // 5. Re-encrypt entries: decrypt with OLD encryptionKey, re-encrypt with newEncKey
        const userId = sessionUserId;
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

        // Locked while re-encrypting: lock() also dropped the ECDH key, and a
        // rotation for a vault the user has already left must not be sent.
        // Nothing was sent; the finally drops the new key.
        if (lockEpochRef.current !== lockEpoch) return ROTATION_NOT_STARTED_VAULT_LOCKED;

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
        const newAuthKeyBytes = await deriveAuthKeyBytes(newSecretKey);
        let newAuthHash: string;
        try {
          newAuthHash = await computeAuthHash(newAuthKeyBytes);
        } finally {
          newAuthKeyBytes.fill(0);
        }
        const newVerifierHash = await computePassphraseVerifier(passphrase, newAccountSalt);
        const verificationArtifact = await createVerificationArtifact(newEncKey);

        // 11. POST to /api/vault/rotate-key
        onProgress?.({ phase: "committing", current: 0, total: 1 });
        // The same, for a lock while the new wrap was being derived: checked
        // immediately before the POST.
        if (lockEpochRef.current !== lockEpoch) return ROTATION_NOT_STARTED_VAULT_LOCKED;

        let res: Response;
        try {
          res = await fetchApi(API_PATH.VAULT_ROTATE_KEY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentAuthHash,
              currentVerifierHash,
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
        } catch {
          lock();
          throw new VaultChangeOutcomeUnknownError();
        }

        if (!res.ok) {
          const err = await readApiErrorBody(res);
          if (err?.error === WRAP_MOVED_ELSEWHERE_ROTATE_KEY) {
            lock();
            throw new VaultChangedElsewhereError(err.error);
          }
          if (!err || !ROTATE_KEY_REFUSALS.has(err.error)) {
            lock();
            throw new VaultChangeOutcomeUnknownError();
          }
          throw err;
        }

        // Committed, but the vault was locked while the request was in flight:
        // installing the new key would refill a locked vault. The finally drops
        // it, and the next unlock reads the committed wrap.
        if (lockEpochRef.current !== lockEpoch) return ROTATION_COMMITTED_VAULT_LOCKED;

        // The rotation has committed: the server now holds only the new wrapping
        // and every row is under the new key. An unreadable body must not keep
        // the old key in memory — the client already holds everything it sent,
        // so it switches regardless, and only the server's report is lost.
        const parsed = await parseJsonBodyOnce(res);
        const result =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { keyVersion?: unknown; rotationEffects?: RotationEffects })
            : null;

        // 12. Update in-memory state. The retired key is zeroed first: every
        // reader got a copy of it (getSecretKey), never this buffer.
        secretKeyRef.current?.fill(0);
        secretKeyRef.current = new Uint8Array(newSecretKey);
        commitKeyVersion(typeof result?.keyVersion === "number" ? result.keyVersion : newKeyVersion);
        accountSaltRef.current = newAccountSalt;
        wrappedKeyRef.current = {
          ciphertext: newWrappedKey.ciphertext,
          iv: newWrappedKey.iv,
          authTag: newWrappedKey.authTag,
        };
        // ecdhPrivateKeyBytesRef remains valid — private key bytes did not change.
        setEncryptionKey(newEncKey);
        if (!result) return ROTATION_EFFECTS_UNAVAILABLE;
        // The dialog uses these counts to surface operator banners.
        const effects = result.rotationEffects;
        if (effects) {
          return { ...effects, legacyAttachmentsMigrated };
        }
        return null;
      } finally {
        // The success path copied it into secretKeyRef; every other path
        // (a refusal, an unknown outcome, a throw while re-encrypting) drops it.
        newSecretKey.fill(0);
      }
    },
    [encryptionKey, sessionUserId, commitKeyVersion, lock, verifyPassphrase],
  );

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
          keyVersion={keyVersion}
          userId={session?.user?.id}
          pollingSuspended={passkeyGated}
        >
          <TeamVaultProvider
            getEcdhPrivateKeyBytes={getEcdhPrivateKeyBytes}
            getUserId={getUserId}
            vaultUnlocked={vaultStatus === VAULT_STATUS.UNLOCKED}
            pollingSuspended={passkeyGated}
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
