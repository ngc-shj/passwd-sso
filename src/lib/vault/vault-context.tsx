"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { API_PATH, apiPath, VAULT_STATUS, ATTACHMENT_ENCRYPTION_MODE, INITIAL_VAULT_KEY_VERSION } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseJsonBodyOnce, readApiErrorBody } from "@/lib/http/read-api-error-body";
import { fetchApi, SessionChangedError } from "@/lib/url-helpers";
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
import { PRE_ROUTE_AND_PRE_TX_REFUSALS, is5xxPreRouteRefusal } from "./pre-commit-refusals";
import { VAULT_SETUP_OUTCOME_UNKNOWN, VAULT_UNLOCK_INTERRUPTED } from "./vault-unlock-codes";

export { VAULT_SETUP_OUTCOME_UNKNOWN, VAULT_UNLOCK_INTERRUPTED };

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

/**
 * Decrypt the vault's ECDH private key (team E2E) with the unwrapped secret
 * key. Null when the vault holds none or it does not decrypt — non-fatal, team
 * features are then unavailable. The returned view is over the decrypted
 * buffer itself: the caller zeroes it once it has been copied in.
 */
async function decryptEcdhPrivateKey(
  secretKey: Uint8Array,
  vaultData: { encryptedEcdhPrivateKey?: string; ecdhPrivateKeyIv?: string; ecdhPrivateKeyAuthTag?: string },
): Promise<Uint8Array | null> {
  if (!vaultData.encryptedEcdhPrivateKey || !vaultData.ecdhPrivateKeyIv || !vaultData.ecdhPrivateKeyAuthTag) {
    return null;
  }
  try {
    const ecdhWrapKey = await deriveEcdhWrappingKey(secretKey);
    const decrypted = await decryptBinary(
      {
        ciphertext: hexDecode(vaultData.encryptedEcdhPrivateKey),
        iv: vaultData.ecdhPrivateKeyIv,
        authTag: vaultData.ecdhPrivateKeyAuthTag,
      },
      ecdhWrapKey,
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
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
 * Discriminant of `rotateKey`'s result when the server committed the rotation
 * but the vault was locked (auto-lock, the user, page hide) after the request
 * was sent. The new key material was not installed into the locked vault; the
 * next unlock reads the committed wrap. The caller must not report the vault
 * as usable, but still reports the rotation's effects.
 */
export const ROTATION_COMMITTED_VAULT_LOCKED = "ROTATION_COMMITTED_VAULT_LOCKED";

export interface RotationCommittedVaultLocked {
  outcome: typeof ROTATION_COMMITTED_VAULT_LOCKED;
  effects: RotationEffects | typeof ROTATION_EFFECTS_UNAVAILABLE | null;
}

/**
 * `rotateKey`'s result when the vault was locked before the rotation was sent,
 * or the server refused it after the vault was locked. Nothing was written:
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

/** `changePassphrase`'s counterpart of ROTATION_COMMITTED_VAULT_LOCKED. */
export const PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED = "PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED";

export interface PassphraseChangeCommittedVaultLocked {
  outcome: typeof PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED;
  effects: PassphraseChangeEffects;
}

/** `changePassphrase`'s counterpart of ROTATION_NOT_STARTED_VAULT_LOCKED. */
export const PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED = "PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED";

export type PassphraseChangeResult =
  | PassphraseChangeEffects
  | PassphraseChangeCommittedVaultLocked
  | typeof PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;

export type RotateKeyResult =
  | RotationEffects
  | typeof ROTATION_EFFECTS_UNAVAILABLE
  | RotationCommittedVaultLocked
  | typeof ROTATION_NOT_STARTED_VAULT_LOCKED
  | null;

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
  changePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<PassphraseChangeResult>;
  rotateKey: (
    passphrase: string,
    onProgress?: (progress: { phase: "migrating" | "rewrapping" | "committing" | "entries" | "history", current: number, total: number }) => void,
  ) => Promise<RotateKeyResult>;
  verifyPassphrase: (passphrase: string) => Promise<boolean>;
  /** The current lock epoch, for a flow outside the provider to pass to lockedSince. */
  getLockEpoch: () => number;
  /** Whether the vault was locked (its key material dropped) since `epoch`. */
  lockedSince: (epoch: number) => boolean;
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
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [prevSessionStatus, setPrevSessionStatus] = useState(sessionStatus);
  if (sessionStatus !== prevSessionStatus) {
    setPrevSessionStatus(sessionStatus);
    if (sessionStatus === "unauthenticated") {
      setVaultStatus(VAULT_STATUS.LOCKED);
    }
  }
  // An ended session never renders an unlocked vault. Its key refs are dropped
  // by the session-change effect below.
  if (sessionStatus === "unauthenticated" && vaultStatus === VAULT_STATUS.UNLOCKED) {
    setVaultStatus(VAULT_STATUS.LOCKED);
    setEncryptionKey(null);
  }
  // Nor does a switched user's: next-auth's setSession(B) goes authenticated →
  // authenticated, and A's vault must not render unlocked under B's cookie.
  // Nor A's setup wizard: A's "no vault" verdict says nothing about B's, so
  // the vault waits in LOADING for B's status check to decide.
  // A switch is a change between two defined ids, so the last defined id is
  // kept: undefined → id (the first id, or a refetch briefly carrying none) is
  // not a switch, and a same-user refetch carries the same id.
  const [prevSessionUserId, setPrevSessionUserId] = useState(sessionUserId);
  if (sessionUserId !== undefined && sessionUserId !== prevSessionUserId) {
    setPrevSessionUserId(sessionUserId);
    if (prevSessionUserId !== undefined && vaultStatus === VAULT_STATUS.UNLOCKED) {
      setVaultStatus(VAULT_STATUS.LOCKED);
      setEncryptionKey(null);
    } else if (prevSessionUserId !== undefined && vaultStatus === VAULT_STATUS.SETUP_REQUIRED) {
      setVaultStatus(VAULT_STATUS.LOADING);
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
  // Bumped whenever the key material is dropped. Only dropKeyRefs writes it
  // and only dropKeyRefs drops key material, so the two cannot drift.
  const lockEpochRef = useRef(0);
  // The session status and the last defined session user id as of the last
  // commit, for the session-change effect and installKeyMaterial.
  const sessionStatusRef = useRef(sessionStatus);
  const sessionUserIdRef = useRef(sessionUserId);
  // Whether the last applied vault status said the server holds no vault. An
  // unlock whose POST the server accepted before a reset must not install
  // into it; only setup, which clears this once its POST commits, may.
  const setupRequiredRef = useRef(false);
  // Counts unlocking installs (setup and the unlock paths), so a vault status
  // response can tell whether the vault was unlocked after its request started.
  // A change or rotation does not count: it re-keys a vault already unlocked,
  // so it cannot make a setupRequired verdict stale.
  const installCountRef = useRef(0);
  // The latest vault status request; an earlier one's response is stale.
  const statusRequestRef = useRef(0);
  // Counts setupRequired verdicts applied, so a setup can tell whether one
  // arrived while its POST was in flight.
  const setupVerdictCountRef = useRef(0);
  // Bumped to ask the vault status again for the current session (the status
  // effect re-runs with that session's own guards).
  const [statusCheckRequest, setStatusCheckRequest] = useState(0);
  const requestStatusCheck = useCallback(() => setStatusCheckRequest((n) => n + 1), []);

  // Whether the key material was dropped since a flow captured `epoch` at its
  // start. A flow checks it after every await that precedes reading the refs
  // or sending a request.
  const lockedSince = useCallback((epoch: number) => lockEpochRef.current !== epoch, []);

  // Zero and drop the key refs and move the lock epoch; no state. The session
  // end effect calls it alone (render has already settled the state), every
  // other lock through dropKeyMaterial.
  const dropKeyRefs = useCallback(() => {
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
  }, []);

  const dropKeyMaterial = useCallback(() => {
    dropKeyRefs();
    setEncryptionKey(null);
    setVaultStatus((prev) =>
      prev === VAULT_STATUS.UNLOCKED ? VAULT_STATUS.LOCKED : prev
    );
  }, [dropKeyRefs]);

  /**
   * The only writer of key material into the provider for setup, the unlock
   * paths, changePassphrase and rotateKey. Synchronous: between its epoch check
   * and its writes nothing can run, so a lock since `epoch` (the flow's start)
   * either happened before the check — and nothing is installed — or happens
   * after, and drops what was installed. A session end or user switch moves
   * the epoch (the session-change effect), so a flow started before either is
   * refused; one started after the session ended is refused by the status
   * check. It also refuses while the server reports no vault (see
   * setupRequiredRef). Buffers are copied in; the caller zeroes its own.
   * Returns false when it refused.
   */
  const installKeyMaterial = useCallback(
    (
      epoch: number,
      material: {
        accountSalt: Uint8Array;
        wrappedKey: { ciphertext: string; iv: string; authTag: string };
        secretKey?: Uint8Array;
        keyVersion?: number;
        encryptionKey?: CryptoKey;
        ecdh?: { privateKeyBytes: Uint8Array; publicKeyJwk: string | null };
        markUnlocked?: boolean;
      },
    ): boolean => {
      if (lockEpochRef.current !== epoch || sessionStatusRef.current === "unauthenticated") return false;
      if (setupRequiredRef.current) return false;
      if (material.markUnlocked) installCountRef.current += 1;
      if (material.secretKey) {
        // Every reader got a copy (getSecretKey), never this buffer.
        secretKeyRef.current?.fill(0);
        secretKeyRef.current = new Uint8Array(material.secretKey);
      }
      if (material.keyVersion !== undefined) commitKeyVersion(material.keyVersion);
      accountSaltRef.current = material.accountSalt;
      wrappedKeyRef.current = {
        ciphertext: material.wrappedKey.ciphertext,
        iv: material.wrappedKey.iv,
        authTag: material.wrappedKey.authTag,
      };
      if (material.ecdh) {
        ecdhPrivateKeyBytesRef.current?.fill(0);
        ecdhPrivateKeyBytesRef.current = new Uint8Array(material.ecdh.privateKeyBytes);
        ecdhPublicKeyJwkRef.current = material.ecdh.publicKeyJwk;
      }
      if (material.encryptionKey) setEncryptionKey(material.encryptionKey);
      if (material.markUnlocked) setVaultStatus(VAULT_STATUS.UNLOCKED);
      return true;
    },
    [commitKeyVersion],
  );

  // What an unlock throws when installKeyMaterial refused it. An ended session
  // needs a new sign-in (UNAUTHORIZED, as when the server refuses the session);
  // "try again" would loop against a dead session. A page hide, unmount or lock
  // is an interruption.
  const installRefusedError = useCallback(
    () =>
      new VaultUnlockError(
        sessionStatusRef.current === "unauthenticated" ? API_ERROR.UNAUTHORIZED : VAULT_UNLOCK_INTERRUPTED,
      ),
    [],
  );

  // Whether the session ended, or switched away from `userId` (the last
  // defined session user id when a flow started), since. A switch needs both
  // ids defined, as for the session-change drop, so an id that only arrived
  // since (undefined → defined) is not a move. A same-user page hide, unmount
  // or lock is not a move either.
  const sessionMovedFrom = useCallback((userId: string | undefined) => {
    const switched = userId !== undefined && sessionUserIdRef.current !== userId;
    return sessionStatusRef.current === "unauthenticated" || switched;
  }, []);

  // An unlock step after an await: stop once the vault was locked since it
  // started, with the error installKeyMaterial's refusal would give.
  const refuseIfLockedSince = useCallback((epoch: number) => {
    if (lockedSince(epoch)) throw installRefusedError();
  }, [lockedSince, installRefusedError]);

  // A session end or a user switch drops the key refs and moves the epoch —
  // whether or not a key is held — so an in-flight change or rotation reports
  // itself as not started or committed-while-locked, and an unlock or setup in
  // flight installs nothing, even once another user's session has arrived;
  // render has already left UNLOCKED. It also retires the outstanding vault
  // status request: its answer is about the session that ended. A same-user
  // refetch moves nothing, so a focus refetch never refuses an unlock. A layout
  // effect, so the refs are current before any later task can resolve an
  // unlock: a passive effect could still be pending when an install runs,
  // letting it succeed for a session that has already ended.
  useLayoutEffect(() => {
    const ended = sessionStatus === "unauthenticated" && sessionStatusRef.current !== "unauthenticated";
    const switched =
      sessionUserId !== undefined &&
      sessionUserIdRef.current !== undefined &&
      sessionUserId !== sessionUserIdRef.current;
    sessionStatusRef.current = sessionStatus;
    if (sessionUserId !== undefined) sessionUserIdRef.current = sessionUserId;
    if (ended || switched) {
      dropKeyRefs();
      statusRequestRef.current += 1;
      setupRequiredRef.current = false;
    }
  }, [sessionStatus, sessionUserId, dropKeyRefs]);

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
      // Only the latest request applies its response. A setupRequired verdict
      // may be stale once the vault was unlocked (setup or an unlock
      // installed) after the request started — it may predate a setup that
      // has since committed — or genuine (the vault was reset after that
      // unlock), so it is asked again and the newest answer decides.
      const request = ++statusRequestRef.current;
      const installsAtStart = installCountRef.current;
      const isLatest = () => request === statusRequestRef.current;
      try {
        const res = await fetchApi(API_PATH.VAULT_STATUS);
        if (!isLatest() || !res.ok) {
          // A body nobody reads keeps its request loading in Chromium until the
          // Response is collected, and this effect re-runs on every session
          // update, so most page loads supersede one check. Release it unread.
          res.body?.cancel().catch(() => {});
          if (!isLatest()) return;
          setVaultStatus((prev) => prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED);
          return;
        }
        const data = await res.json();
        if (!isLatest()) return;
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
        if (data.setupRequired) {
          if (installCountRef.current !== installsAtStart) return checkVaultStatus();
          // SETUP_REQUIRED always wins (the vault was reset while unlocked):
          // the key material of the reset vault is dropped first. Only when
          // some is held — a status re-check while setup is in flight must not
          // move the epoch, or the setup's install would be refused.
          if (secretKeyRef.current) dropKeyMaterial();
          setupRequiredRef.current = true;
          setupVerdictCountRef.current += 1;
          setVaultStatus(VAULT_STATUS.SETUP_REQUIRED);
          return;
        }
        setupRequiredRef.current = false;
        // Never overwrite "unlocked" — only the lock timer should do that
        setVaultStatus((prev) => (prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED));
      } catch {
        if (!isLatest()) return;
        setVaultStatus((prev) => prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED);
      }
    }

    checkVaultStatus();
  }, [session, sessionStatus, dropKeyMaterial, statusCheckRequest]);

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
    dropKeyMaterial();
  }, [dropKeyMaterial]);

  // A key change whose outcome is unknown, or whose wrap moved elsewhere,
  // locks the vault: an unlock since the change started may hold the stale
  // wrap or key. Not once the session has ended (its key material is already
  // dropped) or switched to another user: that user's vault is not the one
  // the change touched, and the lock would also revoke their delegations.
  // `userId` is the last defined session user id when the change started; a
  // switch needs both ids defined, as for the session-change drop, so an id
  // that only arrived since (undefined → defined) still locks.
  const lockUnlessSessionMoved = useCallback((userId: string | undefined) => {
    if (sessionMovedFrom(userId)) return;
    lock();
  }, [lock, sessionMovedFrom]);

  // ─── SecretKey cleanup on unmount / page unload ─────────────
  // A page hide is a lock: it drops the same material and queues LOCKED with
  // the null encryption key, so a page restored from the bfcache comes back
  // locked. A page frozen before that update rendered keeps it queued on the
  // fiber and renders it on restore; no pageshow handler is needed (INV-C1.6).
  // On unmount the state updates are no-ops.

  useEffect(() => {
    const zeroSensitiveKeys = () => {
      if (secretKeyRef.current) {
        // Vault is unlocked — revoke delegations before zeroing keys
        fetchApi(API_PATH.VAULT_DELEGATION, { method: "DELETE", keepalive: true }).catch(() => {});
      }
      dropKeyMaterial();
    };
    window.addEventListener("pagehide", zeroSensitiveKeys);
    return () => {
      window.removeEventListener("pagehide", zeroSensitiveKeys);
      zeroSensitiveKeys(); // also zero on unmount
    };
  }, [dropKeyMaterial]);

  // ─── Setup (first time) ───────────────────────────────────────

  const setup = useCallback(async (passphrase: string) => {
    const lockEpoch = lockEpochRef.current;
    const startUserId = sessionUserIdRef.current;
    const setupVerdictsAtStart = setupVerdictCountRef.current;
    // Every write below is bound to the state the setup started under. Once
    // the vault was locked (page hide, unmount) or the session ended or
    // switched to another user before the POST, nothing is sent; the current
    // session's status is asked again and decides. The setup throws
    // VAULT_UNLOCK_INTERRUPTED (UNAUTHORIZED once the session has ended, which
    // is asked nothing).
    const refuseIfInterrupted = () => {
      if (!lockedSince(lockEpoch)) return;
      if (sessionStatusRef.current !== "unauthenticated") requestStatusCheck();
      throw installRefusedError();
    };
    // After the POST committed (201, or the vault already exists), only a
    // session that ended or moved to another user refuses: this provider may
    // now serve someone else. A same-user lock does not — the vault exists for
    // this user — and the caller leaves it LOCKED instead of installing.
    const movedRefusal = () => {
      if (sessionStatusRef.current !== "unauthenticated") requestStatusCheck();
      return installRefusedError();
    };
    const refuseIfSessionMoved = () => {
      if (sessionMovedFrom(startUserId)) throw movedRefusal();
    };
    // Checked after the POST's response, before any write. A setupRequired
    // verdict applied while the POST was in flight cannot be ordered against
    // this setup's commit: answered before it, it is stale; after, the vault
    // was reset since. So the status is asked again — after the response, so
    // after the commit — and the setup writes only if the vault still exists
    // and no further verdict arrived meanwhile.
    const refuseIfStale = async () => {
      refuseIfSessionMoved();
      if (setupVerdictCountRef.current === setupVerdictsAtStart) return;
      const verdictsAtAsk = setupVerdictCountRef.current;
      let exists = false;
      try {
        const res = await fetchApi(API_PATH.VAULT_STATUS);
        const body = res.ok ? await parseJsonBodyOnce(res) : null;
        exists =
          typeof body === "object" && body !== null &&
          "setupRequired" in body && body.setupRequired === false;
      } catch {
        // Unanswered: the vault is not confirmed, so nothing is written.
      }
      refuseIfSessionMoved();
      if (!exists || setupVerdictCountRef.current !== verdictsAtAsk) {
        requestStatusCheck();
        throw new VaultUnlockError(VAULT_UNLOCK_INTERRUPTED);
      }
    };

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
      // A copy of exactly the key bytes, zeroed once encrypted.
      const ecdhSourceBytes = ecdhPrivBytes.slice();
      let ecdhEncrypted: Awaited<ReturnType<typeof encryptBinary>>;
      try {
        ecdhEncrypted = await encryptBinary(ecdhSourceBytes.buffer as ArrayBuffer, ecdhWrapKey);
      } finally {
        ecdhSourceBytes.fill(0);
      }

      // 9. Send to server — not when the vault was locked or the session
      // moved while preparing: the request would carry another user's cookie.
      refuseIfInterrupted();
      // The route answers 201 once its write commits, and nothing else after
      // it. A rejected fetch, or a 5xx that is not a pre-route refusal (a
      // proxy's 502/504 page, the 500 for an uncaught throw), may follow that
      // commit: the vault may now exist with this passphrase, so the status is
      // asked again and decides, and the caller is told the outcome is unknown.
      // A same-user lock while the POST was in flight (page hide and bfcache
      // restore, auto-lock) does not change that: the setup may have committed
      // for this user. Only a session that ended or moved to another user is
      // refused as an interruption, as this provider may now serve someone else.
      const outcomeUnknown = () => {
        if (sessionMovedFrom(startUserId)) return movedRefusal();
        requestStatusCheck();
        return new VaultUnlockError(VAULT_SETUP_OUTCOME_UNKNOWN);
      };
      let res: Response;
      try {
        res = await fetchApi(API_PATH.VAULT_SETUP, {
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
      } catch (e) {
        // Refused by the proxy before the route ran: nothing was written.
        if (e instanceof SessionChangedError) throw e;
        throw outcomeUnknown();
      }

      if (!res.ok) {
        // A refused session needs a new sign-in, as for the unlock paths.
        if (res.status === 401) throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        const err = await readApiErrorBody(res);
        if (res.status >= 500 && !is5xxPreRouteRefusal(err?.error)) {
          throw outcomeUnknown();
        }
        // The vault exists (this setup's 201 was lost and it was retried, or
        // another tab set it up): leave it LOCKED for an unlock, whether or not
        // a same-user lock came meanwhile. An unlock may already have completed:
        // once a status check found the vault, nothing stops one while this
        // POST is in flight, and its UNLOCKED state and keys are kept.
        if (err?.error === API_ERROR.VAULT_ALREADY_SETUP) {
          await refuseIfStale();
          setupRequiredRef.current = false;
          setVaultStatus((prev) => (prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED));
          return;
        }
        throw new Error(err?.error || "Setup failed");
      }
      await refuseIfStale();
      setupRequiredRef.current = false;
      // Committed for this user, but locked since it started (page hide and
      // bfcache restore, auto-lock): nothing is installed, and the vault is
      // left LOCKED for an unlock with the passphrase just entered — as when
      // the vault already exists — not reported as an interrupted unlock. That
      // unlock may already have completed after the lock (as for
      // VAULT_ALREADY_SETUP above), so UNLOCKED is kept.
      if (lockedSince(lockEpoch)) {
        setVaultStatus((prev) => (prev === VAULT_STATUS.UNLOCKED ? prev : VAULT_STATUS.LOCKED));
        return;
      }

      // 10. Store secretKey, keyVersion, accountSalt, wrappedKey, ECDH keys, and
      // encryption key in memory. Not synchronous with the checks above:
      // refuseIfStale is async, so even its fast path resumes here a microtask
      // later. installKeyMaterial checks the lock epoch itself as it writes, so
      // a lock in between is refused there, and the check below reports that
      // refusal instead of passing it as success.
      const installed = installKeyMaterial(lockEpoch, {
        secretKey,
        keyVersion: INITIAL_VAULT_KEY_VERSION,
        accountSalt,
        wrappedKey,
        ecdh: { privateKeyBytes: ecdhPrivBytes, publicKeyJwk: ecdhPubJwk },
        encryptionKey: encKey,
        markUnlocked: true,
      });
      if (!installed) throw installRefusedError();
    } finally {
      // The success path copied both into refs; a rejected or refused POST, or
      // a throw while deriving, must not leave them in memory.
      secretKey.fill(0);
      ecdhPrivBytes?.fill(0);
      authKeyBytes?.fill(0);
    }
  }, [installKeyMaterial, installRefusedError, lockedSince, requestStatusCheck, sessionMovedFrom]);

  // ─── Unlock ───────────────────────────────────────────────────

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    // A page hide or unmount while unlocking drops what this unlock would
    // install: installKeyMaterial refuses, and the unlock throws
    // VAULT_UNLOCK_INTERRUPTED (UNAUTHORIZED once the session has ended).
    const lockEpoch = lockEpochRef.current;
    const startUserId = sessionUserIdRef.current;
    // One finally zeroes the unwrapped key, the auth key bytes and the ECDH
    // private key on every exit — a refused or rejected unlock POST included;
    // the success path copied the keys into the refs.
    let secretKey: Uint8Array | null = null;
    let authKeyBytes: Uint8Array | null = null;
    let ecdhPrivateKeyBytes: Uint8Array | null = null;
    const refuseIfSessionMoved = () => {
      if (sessionMovedFrom(startUserId)) throw installRefusedError();
    };
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
        // Passphrase is wrong — notify server for lockout tracking. Not once
        // the session ended or switched since the unlock started: under
        // another user's cookie the failure would count against them. A
        // same-user page hide, unmount or lock still reports it: the attempt
        // was made under this user's session, and the lockout must count it.
        // Network failures are swallowed (VaultUnlockError propagates for lockout UI).
        refuseIfSessionMoved();
        try { await notifyUnlockFailure(); } catch (e) { if (e instanceof VaultUnlockError || e instanceof SessionChangedError) throw e; }
        return false;
      }
      secretKey = unwrapped;

      // 4. Derive encryption key and verify with artifact
      const encKey = await deriveEncryptionKey(secretKey);
      if (vaultData.verificationArtifact) {
        const valid = await verifyKey(encKey, vaultData.verificationArtifact);
        if (!valid) {
          refuseIfSessionMoved();
          try { await notifyUnlockFailure(); } catch (e) { if (e instanceof VaultUnlockError || e instanceof SessionChangedError) throw e; }
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

      // Not sent once the vault was locked or the session moved while
      // deriving: under another user's cookie it would count against them.
      refuseIfLockedSince(lockEpoch);
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

      // 6. Restore ECDH private key if available (team E2E)
      ecdhPrivateKeyBytes = await decryptEcdhPrivateKey(secretKey, vaultData);

      // 7. Store secretKey, keyVersion, accountSalt, wrappedKey (for EA
      // auto-confirm and changePassphrase), the ECDH key and the encryption key
      if (!installKeyMaterial(lockEpoch, {
        secretKey,
        keyVersion: vaultData.keyVersion ?? 1,
        accountSalt,
        wrappedKey: {
          ciphertext: vaultData.encryptedSecretKey,
          iv: vaultData.secretKeyIv,
          authTag: vaultData.secretKeyAuthTag,
        },
        ecdh: ecdhPrivateKeyBytes
          ? { privateKeyBytes: ecdhPrivateKeyBytes, publicKeyJwk: vaultData.ecdhPublicKey ?? null }
          : undefined,
        encryptionKey: encKey,
        markUnlocked: true,
      })) {
        throw installRefusedError();
      }

      // 8. Auto-confirm pending emergency access grants (async nonblocking)
      const userId = sessionUserId;
      if (userId && secretKeyRef.current) {
        const sk = new Uint8Array(secretKeyRef.current);
        confirmPendingEmergencyGrants(sk, userId, keyVersionRef.current)
          .catch(() => {})
          .finally(() => sk.fill(0));
      }

      return true;
    } catch (err) {
      // A session that changed since the page loaded is refused before any
      // route runs: no attempt was made, so it is never a wrong passphrase.
      if (err instanceof VaultUnlockError || err instanceof SessionChangedError) throw err;
      return false;
    } finally {
      secretKey?.fill(0);
      authKeyBytes?.fill(0);
      ecdhPrivateKeyBytes?.fill(0);
    }
  }, [sessionUserId, installKeyMaterial, installRefusedError, refuseIfLockedSince, sessionMovedFrom]);

  // ─── Unlock with Passkey (PRF) ───────────────────────────────

  const unlockWithPasskey = useCallback(async (): Promise<boolean> => {
    // One finally zeroes the PRF output, the unwrapped key and the auth key
    // bytes and the ECDH private key on every exit (a refused or rejected
    // verify or unlock POST included); the success path copied the keys into
    // the refs. A page hide while unlocking refuses the install, as in unlock.
    const lockEpoch = lockEpochRef.current;
    let prfOutput: Uint8Array | null = null;
    let secretKey: Uint8Array | null = null;
    let authKeyBytes: Uint8Array | null = null;
    let ecdhPrivateKeyBytes: Uint8Array | null = null;
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

      // 3. Verify with server — get PRF-encrypted secretKey. Not sent once the
      // vault was locked or the session moved during the ceremony.
      refuseIfLockedSince(lockEpoch);
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

      refuseIfLockedSince(lockEpoch);
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

      // 7. Restore ECDH private key if available
      ecdhPrivateKeyBytes = await decryptEcdhPrivateKey(secretKey, vaultData);

      // 8. Store refs and set unlocked (same as passphrase unlock)
      if (!installKeyMaterial(lockEpoch, {
        secretKey,
        keyVersion: vaultData.keyVersion ?? 1,
        accountSalt: hexDecode(vaultData.accountSalt),
        wrappedKey: {
          ciphertext: vaultData.encryptedSecretKey,
          iv: vaultData.secretKeyIv,
          authTag: vaultData.secretKeyAuthTag,
        },
        ecdh: ecdhPrivateKeyBytes
          ? { privateKeyBytes: ecdhPrivateKeyBytes, publicKeyJwk: vaultData.ecdhPublicKey ?? null }
          : undefined,
        encryptionKey: encKey,
        markUnlocked: true,
      })) {
        throw installRefusedError();
      }

      // 9. Auto-confirm pending emergency access grants
      const userId = sessionUserId;
      if (userId && secretKeyRef.current) {
        const sk = new Uint8Array(secretKeyRef.current);
        confirmPendingEmergencyGrants(sk, userId, keyVersionRef.current)
          .catch(() => {})
          .finally(() => sk.fill(0));
      }

      return true;
    } catch (err) {
      // A session that changed since the page loaded is refused before any
      // route runs: no attempt was made, so it is never a wrong passphrase.
      if (err instanceof VaultUnlockError || err instanceof SessionChangedError) throw err;
      // User cancelled WebAuthn dialog — not an error
      if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
        return false;
      }
      return false;
    } finally {
      prfOutput?.fill(0);
      secretKey?.fill(0);
      authKeyBytes?.fill(0);
      ecdhPrivateKeyBytes?.fill(0);
    }
  }, [sessionUserId, installKeyMaterial, installRefusedError, refuseIfLockedSince]);

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
    // here so the finally covers the post-derivation throw paths too, and the
    // decrypted ECDH private key. A page hide while unlocking refuses the
    // install, as in unlock.
    const lockEpoch = lockEpochRef.current;
    const prfOutput = handoff.prfOutput;
    let secretKey: Uint8Array | null = null;
    let authKeyBytes: Uint8Array | null = null;
    let ecdhPrivateKeyBytes: Uint8Array | null = null;
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

      refuseIfLockedSince(lockEpoch);
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

      // Restore ECDH private key if available
      ecdhPrivateKeyBytes = await decryptEcdhPrivateKey(secretKey, vaultData);

      // Store refs and set unlocked (same as passkey unlock)
      if (!installKeyMaterial(lockEpoch, {
        secretKey,
        keyVersion: vaultData.keyVersion ?? 1,
        accountSalt: hexDecode(vaultData.accountSalt),
        wrappedKey: {
          ciphertext: vaultData.encryptedSecretKey,
          iv: vaultData.secretKeyIv,
          authTag: vaultData.secretKeyAuthTag,
        },
        ecdh: ecdhPrivateKeyBytes
          ? { privateKeyBytes: ecdhPrivateKeyBytes, publicKeyJwk: vaultData.ecdhPublicKey ?? null }
          : undefined,
        encryptionKey: encKey,
        markUnlocked: true,
      })) {
        throw installRefusedError();
      }

      // Auto-confirm pending emergency access grants
      const userId = sessionUserId;
      if (userId && secretKeyRef.current) {
        const sk = new Uint8Array(secretKeyRef.current);
        confirmPendingEmergencyGrants(sk, userId, keyVersionRef.current)
          .catch(() => {})
          .finally(() => sk.fill(0));
      }

      return true;
    } catch (err) {
      // A session that changed since the page loaded is refused before any
      // route runs: no attempt was made, so it is never a wrong passphrase.
      if (err instanceof VaultUnlockError || err instanceof SessionChangedError) throw err;
      return false;
    } finally {
      prfOutput.fill(0);
      secretKey?.fill(0);
      authKeyBytes?.fill(0);
      ecdhPrivateKeyBytes?.fill(0);
    }
  }, [sessionUserId, installKeyMaterial, installRefusedError, refuseIfLockedSince]);

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
    async (currentPassphrase: string, newPassphrase: string): Promise<PassphraseChangeResult> => {
      if (!accountSaltRef.current || !secretKeyRef.current) {
        throw new Error("Vault must be unlocked to change passphrase");
      }
      // A lock from here on drops the key material this change started from.
      // Before the POST is sent it is checked after every await (nothing is
      // sent); after, installKeyMaterial refuses to install the new wrap.
      const lockEpoch = lockEpochRef.current;
      const sessionUserAtStart = sessionUserIdRef.current;

      // 0. Refuse a mistyped current passphrase locally, with the vault left
      // unlocked. A server INVALID_PASSPHRASE after this check passed then
      // means the verifier moved elsewhere (see below).
      const currentOk = await verifyPassphrase(currentPassphrase);
      if (lockedSince(lockEpoch)) return PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;
      if (!currentOk) throw { error: API_ERROR.INVALID_PASSPHRASE };

      // 1. Compute current verifier for server-side identity confirmation
      const currentVerifierHash = await computePassphraseVerifier(
        currentPassphrase,
        accountSaltRef.current
      );
      if (lockedSince(lockEpoch)) return PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;

      // 2. Generate new account salt
      const newAccountSalt = generateAccountSalt();

      // 3. Derive new wrapping key and re-wrap secretKey
      const newWrappingKey = await deriveWrappingKey(newPassphrase, newAccountSalt);
      // The null check only narrows the type: the refs are dropped only by
      // dropKeyMaterial, which moves the epoch.
      if (lockedSince(lockEpoch) || !secretKeyRef.current) return PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;
      const rewrapped = await wrapSecretKey(secretKeyRef.current, newWrappingKey);
      if (lockedSince(lockEpoch)) return PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;

      // 4. Compute new verifier
      const newVerifierHash = await computePassphraseVerifier(
        newPassphrase,
        newAccountSalt
      );

      // 5. Send to server — not when the vault was locked while preparing.
      if (lockedSince(lockEpoch)) return PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;
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
      } catch (e) {
        // Refused by the proxy before the route ran: nothing was written.
        if (e instanceof SessionChangedError) throw e;
        lockUnlessSessionMoved(sessionUserAtStart);
        throw new VaultChangeOutcomeUnknownError();
      }

      // SESSION_INVALIDATE_FAILED is returned after the new wrap committed,
      // so it must still update the local refs below or they go stale.
      let invalidationFailed = false;
      if (!res.ok) {
        const err = await readApiErrorBody(res);
        // The server's verifier refused the passphrase the local check above
        // accepted: the wrap moved elsewhere, and this tab's state is stale.
        if (
          err?.error === WRAP_MOVED_ELSEWHERE_CHANGE_PASSPHRASE ||
          err?.error === API_ERROR.INVALID_PASSPHRASE
        ) {
          lockUnlessSessionMoved(sessionUserAtStart);
          throw new VaultChangedElsewhereError(err.error);
        }
        if (err?.error !== API_ERROR.SESSION_INVALIDATE_FAILED) {
          if (!err || !PRE_ROUTE_AND_PRE_TX_REFUSALS.has(err.error)) {
            lockUnlessSessionMoved(sessionUserAtStart);
            throw new VaultChangeOutcomeUnknownError();
          }
          // Refused before committing, but the vault has been locked since:
          // there is no dialog left to show the refusal inline.
          if (lockedSince(lockEpoch)) return PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED;
          throw err;
        }
        invalidationFailed = true;
      }

      // 6. Update local accountSalt and wrappedKey (secretKey unchanged) —
      // unless the vault was locked after the request was sent: the next
      // unlock reads the committed wrap, and a locked vault holds no wrap.
      const installed = installKeyMaterial(lockEpoch, {
        accountSalt: newAccountSalt,
        wrappedKey: rewrapped,
      });
      if (!installed) {
        return { outcome: PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED, effects: { invalidationFailed } };
      }
      return { invalidationFailed };
    },
    [lockUnlessSessionMoved, lockedSince, installKeyMaterial, verifyPassphrase]
  );

  // ─── Rotate Key ───────────────────────────────────────────────

  const rotateKey = useCallback(
    async (
      passphrase: string,
      onProgress?: (progress: { phase: "migrating" | "rewrapping" | "committing" | "entries" | "history", current: number, total: number }) => void,
    ): Promise<RotateKeyResult> => {
      if (!secretKeyRef.current || !accountSaltRef.current || !encryptionKey) {
        throw new Error("Vault must be unlocked to rotate key");
      }

      const oldEncryptionKey = encryptionKey;
      const oldKeyVersion = keyVersionRef.current;
      // A lock from here on drops the key material this rotation started from.
      // Until the rotate POST is sent, every await that precedes reading the
      // refs or sending a request is followed by a lockedSince check, and a
      // throw once locked is reported the same way (catch below): nothing of
      // the rotation is sent, and the result is ROTATION_NOT_STARTED_VAULT_LOCKED.
      // After it is sent, installKeyMaterial refuses to install into a vault
      // locked since here.
      const lockEpoch = lockEpochRef.current;
      const sessionUserAtStart = sessionUserIdRef.current;
      const newSecretKey = generateSecretKey();
      let sent = false;
      try {
        // The new wrap and verifier are derived from the typed passphrase, so a
        // typo would become the new passphrase. Refuse it here before
        // re-encrypting anything, with the vault left unlocked. A server
        // INVALID_PASSPHRASE after this check passed then means the verifier
        // moved elsewhere (see the response handling).
        const passphraseOk = await verifyPassphrase(passphrase);
        if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
        if (!passphraseOk) {
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
        if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
        const currentVerifierHash = await computePassphraseVerifier(passphrase, accountSaltRef.current);
        if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;

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
            if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;

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

            if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
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
          if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
          const refetchRes = await fetchApi(API_PATH.VAULT_ROTATE_KEY_DATA);
          if (!refetchRes.ok) {
            throw new Error("ROTATE_DATA_REFETCH_FAILED");
          }
          currentRotationData = (await refetchRes.json()) as typeof currentRotationData;
        }

        const { entries, historyEntries } = rotationData;

        // 4. Derive the new encryption key from the new secret key
        const newEncKey = await deriveEncryptionKey(newSecretKey);
        const newKeyVersion = oldKeyVersion + 1;

        // 5. Re-encrypt entries: decrypt with OLD encryptionKey, re-encrypt with newEncKey
        const userId = sessionUserId;
        const totalEntries = entries.length;
        const reencryptedEntries = [];
        // Each loop below decrypts under the old key: a lock stops it at the
        // next row, and the rotation is not sent.
        for (let i = 0; i < totalEntries; i++) {
          if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
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
          if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
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
          if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
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

        // 8. Re-wrap ECDH private key with new secret key. Locked while
        // re-encrypting or deriving: the lock dropped the ECDH key, and a
        // rotation for a vault the user has already left must not be sent.
        const ecdhWrapKey = await deriveEcdhWrappingKey(newSecretKey);
        if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
        if (!ecdhPrivateKeyBytesRef.current) {
          throw new Error("ECDH_KEY_UNAVAILABLE");
        }
        // A copy of exactly the key bytes, zeroed once encrypted.
        const ecdhSourceBytes = ecdhPrivateKeyBytesRef.current.slice();
        let ecdhEncrypted: Awaited<ReturnType<typeof encryptBinary>>;
        try {
          ecdhEncrypted = await encryptBinary(ecdhSourceBytes.buffer as ArrayBuffer, ecdhWrapKey);
        } finally {
          ecdhSourceBytes.fill(0);
        }

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
        if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;

        let res: Response;
        sent = true;
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
        } catch (e) {
          // Refused by the proxy before the route ran: nothing was written.
          if (e instanceof SessionChangedError) throw e;
          lockUnlessSessionMoved(sessionUserAtStart);
          throw new VaultChangeOutcomeUnknownError();
        }

        if (!res.ok) {
          const err = await readApiErrorBody(res);
          // The server's verifier refused the passphrase the local check
          // accepted: the wrap moved elsewhere, and this tab's state is stale.
          if (
            err?.error === WRAP_MOVED_ELSEWHERE_ROTATE_KEY ||
            err?.error === API_ERROR.INVALID_PASSPHRASE
          ) {
            lockUnlessSessionMoved(sessionUserAtStart);
            throw new VaultChangedElsewhereError(err.error);
          }
          if (!err || !ROTATE_KEY_REFUSALS.has(err.error)) {
            lockUnlessSessionMoved(sessionUserAtStart);
            throw new VaultChangeOutcomeUnknownError();
          }
          // Refused before committing, but the vault has been locked since:
          // there is no dialog left to show the refusal inline.
          if (lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
          throw err;
        }

        // The rotation has committed: the server now holds only the new wrapping
        // and every row is under the new key. An unreadable body must not keep
        // the old key in memory — the client already holds everything it sent,
        // so it switches regardless, and only the server's report is lost. The
        // body is read even when the vault has been locked, so that its effects
        // (an invalidation failure in particular) still reach the user.
        const parsed = await parseJsonBodyOnce(res);
        const result =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { keyVersion?: unknown; rotationEffects?: RotationEffects })
            : null;
        // The dialog uses these counts to surface operator banners.
        const effects = !result
          ? ROTATION_EFFECTS_UNAVAILABLE
          : result.rotationEffects
            ? { ...result.rotationEffects, legacyAttachmentsMigrated }
            : null;

        // 12. Update in-memory state — unless the vault was locked after the
        // POST was sent: the next unlock reads the committed wrap, and the
        // finally drops the new key. ecdhPrivateKeyBytesRef remains valid —
        // the private key bytes did not change.
        const installed = installKeyMaterial(lockEpoch, {
          secretKey: newSecretKey,
          keyVersion: typeof result?.keyVersion === "number" ? result.keyVersion : newKeyVersion,
          accountSalt: newAccountSalt,
          wrappedKey: newWrappedKey,
          encryptionKey: newEncKey,
        });
        if (!installed) return { outcome: ROTATION_COMMITTED_VAULT_LOCKED, effects };
        return effects;
      } catch (err) {
        // Nothing was sent: a throw once locked is the lock's doing (a dropped
        // ref read) or has no dialog left to show it.
        if (!sent && lockedSince(lockEpoch)) return ROTATION_NOT_STARTED_VAULT_LOCKED;
        throw err;
      } finally {
        // The success path copied it into secretKeyRef; every other path
        // (a refusal, an unknown outcome, a throw while re-encrypting) drops it.
        newSecretKey.fill(0);
      }
    },
    [encryptionKey, sessionUserId, lockUnlessSessionMoved, lockedSince, installKeyMaterial, verifyPassphrase],
  );

  const getSecretKey = useCallback(() => {
    return secretKeyRef.current ? new Uint8Array(secretKeyRef.current) : null;
  }, []);

  const getAccountSalt = useCallback(() => {
    return accountSaltRef.current ? new Uint8Array(accountSaltRef.current) : null;
  }, []);

  const getKeyVersion = useCallback(() => keyVersionRef.current, []);

  const getLockEpoch = useCallback(() => lockEpochRef.current, []);

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
        getLockEpoch,
        lockedSince,
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
            getLockEpoch={getLockEpoch}
            lockedSince={lockedSince}
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
