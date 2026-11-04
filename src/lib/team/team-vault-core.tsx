"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  unwrapTeamKey,
  deriveTeamEncryptionKey,
  createTeamKeyEscrow,
  unwrapItemKey,
  deriveItemEncryptionKey,
  deriveItemCekWrapKey,
  type TeamKeyWrapContext,
} from "../crypto/crypto-team";
import { buildItemKeyWrapAAD } from "../crypto/crypto-aad";
import { apiPath, API_PATH } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { fetchApi } from "@/lib/url-helpers";
import {
  clientLogWarn,
  clientLogError,
  CLIENT_LOG_EVENT,
  CLIENT_LOG_STAGE,
  toClientErrorCode,
  opaque,
  type ClientLogStage,
} from "@/lib/logger/client";
import { isKnownApiError } from "@/lib/http/api-error-codes";
import {
  TEAM_KEY_FAILURE,
  isAesGcmAuthFailure,
  normalizeTeamKeyVersion,
  type TeamKeyFailureReason,
  type TeamKeyResolution,
} from "./team-key-resolution";

export {
  TEAM_KEY_FAILURE,
  type TeamKeyFailureReason,
  type TeamKeyResolution,
} from "./team-key-resolution";

// ─── Types ────────────────────────────────────────────────────

interface CachedTeamKey {
  key: CryptoKey;
  keyVersion: number;
  cachedAt: number;
}

/**
 * Pointer entry cached at `${teamId}:latest`, recording which resolved
 * version number is "latest" for this team. The actual key lives at
 * `${teamId}:${latestVersion}` — look that entry up via the pointer rather
 * than duplicating the CryptoKey in two slots.
 */
interface LatestPointer {
  latestVersion: number;
  cachedAt: number;
}

/** The two keys derived from one ItemKey (plan C5). */
export interface ItemKeys {
  /** Entry blob / overview content key (HKDF "passwd-sso-item-enc-v1"). */
  encryptionKey: CryptoKey;
  /** Team attachment CEK-wrap key (HKDF "passwd-sso-item-cekwrap-v1"). */
  cekWrapKey: CryptoKey;
}

interface CachedItemKeys {
  keys: ItemKeys;
  cachedAt: number;
}

/** The live ItemKey of an entry, with the identity a writer must send back. */
export interface ItemEncryptionKeyInfo {
  keys: ItemKeys;
  itemKeyVersion: number;
  itemKeyId: string | null;
  /** The entry's team key version (the wrap's). */
  teamKeyVersion: number;
}

export interface TeamKeyInfo {
  key: CryptoKey;
  keyVersion: number;
}

export interface EntryItemKeyData {
  itemKeyVersion?: number;
  encryptedItemKey?: string;
  itemKeyIv?: string;
  itemKeyAuthTag?: string;
  /**
   * Identity of the wrapped ItemKey (the entry's, or a history row's own).
   * The ItemKey cache is keyed by (entryId, itemKeyId); a null or absent id
   * is never cached and always re-resolved.
   */
  itemKeyId?: string | null;
  teamKeyVersion: number;
}

export interface TeamVaultContextValue {
  /** Get the team encryption key, fetching and unwrapping if not cached. */
  getTeamEncryptionKey: (teamId: string) => Promise<CryptoKey | null>;
  /** Get the team encryption key with its version number. */
  getTeamKeyInfo: (teamId: string) => Promise<TeamKeyInfo | null>;
  /** Get a specific (possibly non-latest) team encryption key version, e.g. for old history rows. */
  getTeamEncryptionKeyForVersion: (teamId: string, keyVersion: number) => Promise<CryptoKey | null>;
  /**
   * Resolve the team encryption key at a team key version, with the reason
   * when it cannot be resolved (`key_invalid` = the member's own key row at
   * that version fails to unwrap).
   */
  resolveTeamKey: (teamId: string, teamKeyVersion: number) => Promise<TeamKeyResolution>;
  /**
   * Fetch the entry and resolve its live ItemKey: both derived keys plus the
   * identity and version a writer (attachment upload) must send. Throws
   * ItemKeyUpgradeRequiredError for a v0 entry.
   */
  getItemEncryptionKey: (teamId: string, entryId: string) => Promise<ItemEncryptionKeyInfo>;
  /** Get the correct decryption key for an entry or history row (ItemKey-derived if v>=1, TeamKey if v0). */
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>;
  /** Both ItemKey-derived keys of a v>=1 wrap (entry or history row). */
  getEntryItemKeys: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<ItemKeys>;
  /** Invalidate a cached team key (e.g. after key rotation). */
  invalidateTeamKey: (teamId: string) => void;
  /** Clear all cached team keys (e.g. on vault lock). */
  clearAll: () => void;
  /** Distribute team key to pending members (called after vault unlock). */
  distributePendingKeys: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────

const TeamVaultContext = createContext<TeamVaultContextValue | null>(null);

export function useTeamVault(): TeamVaultContextValue {
  const ctx = useContext(TeamVaultContext);
  if (!ctx) {
    throw new Error("useTeamVault must be used within a TeamVaultProvider");
  }
  return ctx;
}

/** Optional accessor — returns null if not inside a TeamVaultProvider. */
export function useTeamVaultOptional(): TeamVaultContextValue | null {
  return useContext(TeamVaultContext);
}

// ─── Constants ────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * MS_PER_MINUTE;
const KEY_DISTRIBUTE_INTERVAL_MS = 2 * MS_PER_MINUTE; // check pending distributions every 2 minutes

type TeamMemberKeyResponse = {
  encryptedTeamKey: string;
  teamKeyIv: string;
  teamKeyAuthTag: string;
  ephemeralPublicKey: string;
  hkdfSalt: string;
  keyVersion: number;
  wrapVersion: number;
};

/** Thrown by getEntryDecryptionKey / getItemEncryptionKey ONLY when a
 * versioned TeamKey fetch fails for a non-transient reason: "not_available"
 * (member-key 404, or server returned a different keyVersion than requested)
 * or "key_invalid" (the member's key row at that version fails to unwrap).
 * Lets callers (e.g. history view) show a distinct message instead of the
 * generic decrypt-failure toast. Transient failures (network/5xx) throw a
 * plain Error instead (F3) — they are not evidence about the key. */
export class TeamKeyVersionUnavailableError extends Error {
  readonly reason: TeamKeyFailureReason;

  constructor(
    teamId: string,
    keyVersion: number,
    reason: TeamKeyFailureReason = TEAM_KEY_FAILURE.NOT_AVAILABLE,
  ) {
    super(`Team key version ${keyVersion} unavailable for team ${teamId}`);
    this.name = "TeamKeyVersionUnavailableError";
    this.reason = reason;
  }
}

/** getItemEncryptionKey on a v0 entry: it has no ItemKey until upgraded. */
export class ItemKeyUpgradeRequiredError extends Error {
  constructor() {
    super("Entry has no ItemKey (itemKeyVersion < 1)");
    this.name = "ItemKeyUpgradeRequiredError";
  }
}

function parseTeamMemberKeyResponse(data: unknown): TeamMemberKeyResponse {
  if (!data || typeof data !== "object") {
    throw new Error("invalid member-key response: not an object");
  }
  const d = data as Record<string, unknown>;
  const isString = (v: unknown) => typeof v === "string" && v.length > 0;
  const isPositiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (
    !isString(d.encryptedTeamKey) ||
    !isString(d.teamKeyIv) ||
    !isString(d.teamKeyAuthTag) ||
    !isString(d.ephemeralPublicKey) ||
    !isString(d.hkdfSalt) ||
    !isPositiveInt(d.keyVersion) ||
    !isPositiveInt(d.wrapVersion)
  ) {
    throw new Error("invalid member-key response: missing or malformed fields");
  }
  return {
    encryptedTeamKey: d.encryptedTeamKey as string,
    teamKeyIv: d.teamKeyIv as string,
    teamKeyAuthTag: d.teamKeyAuthTag as string,
    ephemeralPublicKey: d.ephemeralPublicKey as string,
    hkdfSalt: d.hkdfSalt as string,
    keyVersion: d.keyVersion as number,
    wrapVersion: d.wrapVersion as number,
  };
}

/** ItemKey cache slot: one ItemKey identity of one entry. */
function itemKeySlot(entryId: string, itemKeyId: string): string {
  return `${entryId}:${itemKeyId.toLowerCase()}`;
}

// ─── Provider ─────────────────────────────────────────────────

interface TeamVaultProviderProps {
  children: ReactNode;
  getEcdhPrivateKeyBytes: () => Uint8Array | null;
  getUserId: () => string | null;
  vaultUnlocked: boolean;
  /** True while the session is passkey-blocked or degraded: the proxy refuses the distribution calls. */
  pollingSuspended: boolean;
}

export function TeamVaultProvider({
  children,
  getEcdhPrivateKeyBytes,
  getUserId,
  vaultUnlocked,
  pollingSuspended,
}: TeamVaultProviderProps) {
  // Keyed by `${teamId}:${keyVersion}` for versioned entries, plus a
  // `${teamId}:latest` pointer (LatestPointer) recording which version number
  // is currently "latest" for that team.
  const cacheRef = useRef<Map<string, CachedTeamKey | LatestPointer>>(new Map());
  // Per team: `${entryId}:${itemKeyId}` → both ItemKey-derived keys (C5).
  // Rotation re-wraps an ItemKey without changing it or its id, so the slot
  // stays valid across team key versions; a different id is a different key.
  const itemKeyCacheRef = useRef<Map<string, Map<string, CachedItemKeys>>>(new Map());
  // Bumped by every clear. A populate site captures it before its first await
  // and writes only if it is unchanged, so an unwrap in flight when the vault
  // locks (or a team key is invalidated) cannot repopulate the cleared cache.
  const cacheGenerationRef = useRef(0);

  const clearAll = useCallback(() => {
    cacheGenerationRef.current += 1;
    cacheRef.current.clear();
    itemKeyCacheRef.current.clear();
  }, []);

  const invalidateTeamKey = useCallback((teamId: string) => {
    cacheGenerationRef.current += 1;
    const prefix = `${teamId}:`;
    for (const key of cacheRef.current.keys()) {
      if (key.startsWith(prefix)) {
        cacheRef.current.delete(key);
      }
    }
    itemKeyCacheRef.current.delete(teamId);
  }, []);

  // Shared fetch+unwrap body for getTeamEncryptionKey (latest) and
  // getTeamEncryptionKeyForVersion (history old-key restore). Single
  // implementation of the R39 zeroization discipline: every exit path
  // zero-fills ecdhPrivateKeyBytes, and teamKeyBytes is zero-filled right
  // after deriving the encryption key.
  //
  // On failure, discriminates WHY (F3): "not_available" (404
  // MEMBER_KEY_NOT_FOUND, or the server returned a different keyVersion than
  // requested — genuinely not recoverable by retry), "key_invalid" (the
  // member's key row fails AES-GCM authentication on unwrap) vs "transient"
  // (missing local vault state, network/5xx — may succeed on retry).
  // resolveTeamKey propagates this so getEntryDecryptionKey /
  // getItemEncryptionKey throw TeamKeyVersionUnavailableError only for the
  // first two, never for a transient failure.
  const fetchAndUnwrapTeamKey = useCallback(
    async (
      teamId: string,
      requestedVersion?: number
    ): Promise<
      | { key: CryptoKey; keyVersion: number }
      | { failure: TeamKeyFailureReason }
    > => {
      const ecdhPrivateKeyBytes = getEcdhPrivateKeyBytes();
      const userId = getUserId();
      if (!ecdhPrivateKeyBytes || !userId) {
        return { failure: TEAM_KEY_FAILURE.TRANSIENT };
      }

      let stage: ClientLogStage = CLIENT_LOG_STAGE.FETCH_MEMBER_KEY;
      try {
        const res = await fetchApi(apiPath.teamMemberKey(teamId, requestedVersion));
        if (!res.ok) {
          let errorCode: string | null = null;
          try {
            const body = await res.json();
            if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
              errorCode = body.error;
            }
          } catch {
            // no-op: keep status-based logging
          }
          clientLogWarn(CLIENT_LOG_EVENT.TEAM_MEMBER_KEY_REQUEST_FAILED, {
            teamId: opaque(teamId),
            status: res.status,
            // errorCode comes from the response body and is only checked for
            // being a string, so it is free text as far as this sink is
            // concerned. Bound it to the API_ERROR vocabulary; anything else
            // logs as "other" rather than echoing a server-supplied value into
            // a browser console.
            error: opaque(isKnownApiError(errorCode) ? errorCode : "other"),
          });
          ecdhPrivateKeyBytes.fill(0);
          // 404 MEMBER_KEY_NOT_FOUND is the "genuinely unavailable" signal;
          // any other status (403/5xx/etc.) is transient (F3).
          return {
            failure: res.status === 404 ? TEAM_KEY_FAILURE.NOT_AVAILABLE : TEAM_KEY_FAILURE.TRANSIENT,
          };
        }

        stage = CLIENT_LOG_STAGE.PARSE_MEMBER_KEY;
        const memberKeyData = parseTeamMemberKeyResponse(await res.json());

        // Version assertion: a server-side version swap must not poison the
        // versioned slot or the latest pointer.
        if (requestedVersion !== undefined && memberKeyData.keyVersion !== requestedVersion) {
          clientLogWarn(CLIENT_LOG_EVENT.TEAM_MEMBER_KEY_VERSION_MISMATCH, {
            teamId: opaque(teamId),
            requestedVersion,
            responseVersion: memberKeyData.keyVersion,
          });
          ecdhPrivateKeyBytes.fill(0);
          return { failure: TEAM_KEY_FAILURE.NOT_AVAILABLE };
        }

        // Import ECDH private key, then zero-clear the copy. Pass the
        // TypedArray view directly (importKey copies internally): a
        // `.buffer.slice()` ArrayBuffer both fails SubtleCrypto's realm
        // check under jsdom/Node-20 test environments AND leaves an
        // unzeroed intermediate copy on the heap (R39).
        stage = CLIENT_LOG_STAGE.IMPORT_ECDH_PRIVATE_KEY;
        const ecdhPrivateKey = await crypto.subtle.importKey(
          "pkcs8",
          // Uint8Array default type param is ArrayBufferLike; the vault-context copy is always a plain ArrayBuffer view.
          ecdhPrivateKeyBytes as Uint8Array<ArrayBuffer>,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"]
        );
        ecdhPrivateKeyBytes.fill(0);

        // Build AAD context for unwrapping (asserted version === response version)
        const ctx: TeamKeyWrapContext = {
          teamId,
          toUserId: userId,
          keyVersion: memberKeyData.keyVersion,
          wrapVersion: memberKeyData.wrapVersion,
        };

        // Unwrap team key
        stage = CLIENT_LOG_STAGE.UNWRAP_TEAM_KEY;
        let teamKeyBytes: Uint8Array;
        try {
          teamKeyBytes = await unwrapTeamKey(
            {
              ciphertext: memberKeyData.encryptedTeamKey,
              iv: memberKeyData.teamKeyIv,
              authTag: memberKeyData.teamKeyAuthTag,
            },
            memberKeyData.ephemeralPublicKey,
            ecdhPrivateKey,
            memberKeyData.hkdfSalt,
            ctx
          );
        } catch (e) {
          // The member's own key row exists but fails authentication: not a
          // retryable condition, and not "no key at this version" either.
          if (!isAesGcmAuthFailure(e)) throw e;
          clientLogError(CLIENT_LOG_EVENT.TEAM_ENCRYPTION_KEY_FAILED, {
            teamId: opaque(teamId),
            stage,
            code: toClientErrorCode(e),
          });
          return { failure: TEAM_KEY_FAILURE.KEY_INVALID };
        }

        // Derive encryption key from team key, then zero-clear raw bytes
        stage = CLIENT_LOG_STAGE.DERIVE_TEAM_ENCRYPTION_KEY;
        const encryptionKey = await deriveTeamEncryptionKey(teamKeyBytes);
        teamKeyBytes.fill(0);

        return { key: encryptionKey, keyVersion: memberKeyData.keyVersion };
      } catch (e) {
        // A code, not the message. The removed describeUnknownError() helper
        // concatenated `String(e.cause)` into free text that landed in a
        // production browser console; a key-name denylist cannot inspect what
        // is inside a value, so the value itself must not be free-form.
        clientLogError(CLIENT_LOG_EVENT.TEAM_ENCRYPTION_KEY_FAILED, {
          teamId: opaque(teamId),
          stage,
          code: toClientErrorCode(e),
        });
        ecdhPrivateKeyBytes.fill(0);
        // Any other exception here (network error, malformed response) is
        // transient, not evidence the version is unavailable.
        return { failure: TEAM_KEY_FAILURE.TRANSIENT };
      }
    },
    [getEcdhPrivateKeyBytes, getUserId]
  );

  const getTeamEncryptionKey = useCallback(
    async (teamId: string): Promise<CryptoKey | null> => {
      // Resolve latest via the pointer
      const pointer = cacheRef.current.get(`${teamId}:latest`) as LatestPointer | undefined;
      if (pointer && Date.now() - pointer.cachedAt < CACHE_TTL_MS) {
        const cached = cacheRef.current.get(`${teamId}:${pointer.latestVersion}`) as
          | CachedTeamKey
          | undefined;
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return cached.key;
        }
      }

      const generation = cacheGenerationRef.current;
      const resolved = await fetchAndUnwrapTeamKey(teamId);
      if ("failure" in resolved) return null;
      if (generation !== cacheGenerationRef.current) return resolved.key;

      const cachedAt = Date.now();
      // Non-latest fetches never reach here (no requestedVersion passed above),
      // so it is always safe to write both the versioned slot and the pointer.
      cacheRef.current.set(`${teamId}:${resolved.keyVersion}`, {
        key: resolved.key,
        keyVersion: resolved.keyVersion,
        cachedAt,
      });
      cacheRef.current.set(`${teamId}:latest`, {
        latestVersion: resolved.keyVersion,
        cachedAt,
      });

      return resolved.key;
    },
    [fetchAndUnwrapTeamKey]
  );

  // Internal shared body: resolves a versioned TeamKey (cache or network),
  // returning the failure reason (F3) rather than collapsing to null.
  // getTeamEncryptionKeyForVersion (public) and getEntryDecryptionKey /
  // getItemEncryptionKey (need the reason to pick the right error) both
  // build on this single implementation.
  const getTeamEncryptionKeyForVersionWithReason = useCallback(
    async (
      teamId: string,
      keyVersion: number
    ): Promise<{ key: CryptoKey } | { failure: TeamKeyFailureReason }> => {
      const cacheKey = `${teamId}:${keyVersion}`;
      const cached = cacheRef.current.get(cacheKey) as CachedTeamKey | undefined;
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return { key: cached.key };
      }

      const generation = cacheGenerationRef.current;
      const resolved = await fetchAndUnwrapTeamKey(teamId, keyVersion);
      if ("failure" in resolved) return resolved;
      if (generation !== cacheGenerationRef.current) return { key: resolved.key };

      // Versioned (non-latest) fetches never write the latest pointer slot.
      cacheRef.current.set(cacheKey, {
        key: resolved.key,
        keyVersion: resolved.keyVersion,
        cachedAt: Date.now(),
      });

      return { key: resolved.key };
    },
    [fetchAndUnwrapTeamKey]
  );

  const getTeamEncryptionKeyForVersion = useCallback(
    async (teamId: string, keyVersion: number): Promise<CryptoKey | null> => {
      const resolved = await getTeamEncryptionKeyForVersionWithReason(teamId, keyVersion);
      return "failure" in resolved ? null : resolved.key;
    },
    [getTeamEncryptionKeyForVersionWithReason]
  );

  const getTeamKeyInfo = useCallback(
    async (teamId: string): Promise<TeamKeyInfo | null> => {
      const key = await getTeamEncryptionKey(teamId);
      if (!key) return null;
      const pointer = cacheRef.current.get(`${teamId}:latest`) as LatestPointer | undefined;
      if (!pointer) return null;
      return { key, keyVersion: pointer.latestVersion };
    },
    [getTeamEncryptionKey]
  );

  // Resolves the TeamKey for a normalized version: the cached latest key when
  // it matches, otherwise the specific version via the versioned fetch.
  // Single source of truth for the failure discrimination: "transient" (F3)
  // stays retryable, "not_available" means the member holds no key at that
  // version, "key_invalid" that its own key row there fails to unwrap.
  const resolveTeamKey = useCallback(
    async (teamId: string, teamKeyVersion: number): Promise<TeamKeyResolution> => {
      const normalized = normalizeTeamKeyVersion(teamKeyVersion);
      const keyInfo = await getTeamKeyInfo(teamId);
      if (keyInfo && keyInfo.keyVersion === normalized) {
        return { key: keyInfo.key };
      }
      const resolved = await getTeamEncryptionKeyForVersionWithReason(teamId, normalized);
      return "failure" in resolved ? { reason: resolved.failure } : { key: resolved.key };
    },
    [getTeamKeyInfo, getTeamEncryptionKeyForVersionWithReason]
  );

  // Throwing form for the entry decrypt paths: "not_available" and
  // "key_invalid" throw TeamKeyVersionUnavailableError (so the history UI can
  // show a distinct message), a transient failure throws a plain Error (with
  // failureMessage) for the generic toast.
  const requireTeamKey = useCallback(
    async (teamId: string, teamKeyVersion: number, failureMessage: string): Promise<CryptoKey> => {
      const resolved = await resolveTeamKey(teamId, teamKeyVersion);
      if ("key" in resolved) return resolved.key;
      if (resolved.reason === TEAM_KEY_FAILURE.TRANSIENT) {
        throw new Error(failureMessage);
      }
      throw new TeamKeyVersionUnavailableError(
        teamId,
        normalizeTeamKeyVersion(teamKeyVersion),
        resolved.reason,
      );
    },
    [resolveTeamKey]
  );

  // Both ItemKey-derived keys of a v>=1 wrap. Served from the (entryId,
  // itemKeyId) cache without resolving any team key when that identity was
  // unwrapped before; a null / absent id is never cached (C5).
  const getEntryItemKeys = useCallback(
    async (teamId: string, entryId: string, entry: EntryItemKeyData): Promise<ItemKeys> => {
      const itemKeyId = entry.itemKeyId ?? null;
      if (itemKeyId !== null) {
        const cached = itemKeyCacheRef.current.get(teamId)?.get(itemKeySlot(entryId, itemKeyId));
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return cached.keys;
        }
      }

      const generation = cacheGenerationRef.current;
      if (
        typeof entry.encryptedItemKey !== "string" ||
        typeof entry.itemKeyIv !== "string" ||
        typeof entry.itemKeyAuthTag !== "string"
      ) {
        throw new Error("Entry has itemKeyVersion >= 1 but missing ItemKey encryption data");
      }

      // Version-aware TeamKey resolution (M3): a restored stale-version entry
      // or an old history row unwraps with the TeamKey version it was wrapped
      // under, not the latest one. Legacy schema-default-0 rows were sealed
      // under what became version 1 (normalised inside requireTeamKey).
      const teamKey = await requireTeamKey(
        teamId,
        entry.teamKeyVersion,
        "Failed to obtain team encryption key",
      );

      // AAD uses the row's raw teamKeyVersion as recorded at wrap time —
      // NOT the normalized value — to match what was used when wrapping.
      const ikAad = buildItemKeyWrapAAD(teamId, entryId, entry.teamKeyVersion);
      const rawItemKey = await unwrapItemKey(
        {
          ciphertext: entry.encryptedItemKey,
          iv: entry.itemKeyIv,
          authTag: entry.itemKeyAuthTag,
        },
        teamKey,
        ikAad,
      );
      let keys: ItemKeys;
      try {
        keys = {
          encryptionKey: await deriveItemEncryptionKey(rawItemKey),
          cekWrapKey: await deriveItemCekWrapKey(rawItemKey),
        };
      } finally {
        rawItemKey.fill(0);
      }

      if (itemKeyId !== null && generation === cacheGenerationRef.current) {
        let teamCache = itemKeyCacheRef.current.get(teamId);
        if (!teamCache) {
          teamCache = new Map();
          itemKeyCacheRef.current.set(teamId, teamCache);
        }
        teamCache.set(itemKeySlot(entryId, itemKeyId), { keys, cachedAt: Date.now() });
      }
      return keys;
    },
    [requireTeamKey]
  );

  const getItemEncryptionKey = useCallback(
    async (teamId: string, entryId: string): Promise<ItemEncryptionKeyInfo> => {
      // Always read the entry: the identity a writer sends must be the live
      // one, and the cache is keyed by it.
      const res = await fetchApi(apiPath.teamPasswordById(teamId, entryId));
      if (!res.ok) {
        throw new Error(`Failed to fetch entry ItemKey data (status=${res.status})`);
      }
      const raw = await res.json();

      const itemKeyVersion = typeof raw.itemKeyVersion === "number" ? raw.itemKeyVersion : 0;
      if (itemKeyVersion < 1) {
        throw new ItemKeyUpgradeRequiredError();
      }
      if (typeof raw.teamKeyVersion !== "number") {
        throw new Error("Entry ItemKey data is missing teamKeyVersion");
      }
      const itemKeyId = typeof raw.itemKeyId === "string" ? raw.itemKeyId : null;

      const keys = await getEntryItemKeys(teamId, entryId, {
        itemKeyVersion,
        encryptedItemKey: raw.encryptedItemKey,
        itemKeyIv: raw.itemKeyIv,
        itemKeyAuthTag: raw.itemKeyAuthTag,
        itemKeyId,
        teamKeyVersion: raw.teamKeyVersion,
      });
      return { keys, itemKeyVersion, itemKeyId, teamKeyVersion: raw.teamKeyVersion };
    },
    [getEntryItemKeys]
  );

  const getEntryDecryptionKey = useCallback(
    async (teamId: string, entryId: string, entry: EntryItemKeyData): Promise<CryptoKey> => {
      // v0: the (possibly old) TeamKey directly. Raw-0 rows predate ItemKey
      // mode entirely, so there is no ItemKey unwrap here.
      if ((entry.itemKeyVersion ?? 0) < 1) {
        return requireTeamKey(teamId, entry.teamKeyVersion, "Failed to obtain team encryption key");
      }
      return (await getEntryItemKeys(teamId, entryId, entry)).encryptionKey;
    },
    [requireTeamKey, getEntryItemKeys]
  );

  const distributePendingKeys = useCallback(async () => {
    const ecdhPrivateKeyBytes = getEcdhPrivateKeyBytes();
    const userId = getUserId();
    if (!ecdhPrivateKeyBytes || !userId) return;

    try {
      // Fetch pending key distributions
      const res = await fetchApi(API_PATH.TEAMS_PENDING_KEY_DISTRIBUTIONS);
      if (!res.ok) return;

      const pendingMembers = await res.json();
      if (!Array.isArray(pendingMembers) || pendingMembers.length === 0) return;

      // Import ECDH private key for unwrapping, then zero-clear the copy.
      // TypedArray passed directly — see the same note in
      // fetchAndUnwrapTeamKey (realm check + R39 intermediate copy).
      const ecdhPrivateKey = await crypto.subtle.importKey(
        "pkcs8",
        ecdhPrivateKeyBytes as Uint8Array<ArrayBuffer>,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"]
      );
      ecdhPrivateKeyBytes.fill(0);

      // Group by teamId for efficiency
      const byTeam = new Map<
        string,
        Array<{
          memberId: string;
          teamId: string;
          userId: string;
          ecdhPublicKey: string | null;
          teamKeyVersion: number;
        }>
      >();
      for (const member of pendingMembers) {
        const list = byTeam.get(member.teamId) ?? [];
        list.push(member);
        byTeam.set(member.teamId, list);
      }

      for (const [teamId, members] of byTeam) {
        let teamKeyBytes: Uint8Array | undefined;
        try {
          // Get own team key first
          const ownKeyRes = await fetchApi(apiPath.teamMemberKey(teamId));
          if (!ownKeyRes.ok) continue;

          const ownKeyData = await ownKeyRes.json();

          // Build AAD context for own key unwrapping
          const ownCtx: TeamKeyWrapContext = {
            teamId,
            toUserId: userId,
            keyVersion: ownKeyData.keyVersion,
            wrapVersion: ownKeyData.wrapVersion,
          };

          // Unwrap team key
          teamKeyBytes = await unwrapTeamKey(
            {
              ciphertext: ownKeyData.encryptedTeamKey,
              iv: ownKeyData.teamKeyIv,
              authTag: ownKeyData.teamKeyAuthTag,
            },
            ownKeyData.ephemeralPublicKey,
            ecdhPrivateKey,
            ownKeyData.hkdfSalt,
            ownCtx
          );

          // For each pending member, wrap team key with their ECDH public key
          for (const member of members) {
            try {
              if (!member.ecdhPublicKey) continue;

              const escrow = await createTeamKeyEscrow(
                teamKeyBytes,
                member.ecdhPublicKey,
                teamId,
                member.userId,
                member.teamKeyVersion
              );

              // Send to confirm-key endpoint
              await fetchApi(
                apiPath.teamMemberConfirmKey(teamId, member.memberId),
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    encryptedTeamKey: escrow.encryptedTeamKey,
                    teamKeyIv: escrow.teamKeyIv,
                    teamKeyAuthTag: escrow.teamKeyAuthTag,
                    ephemeralPublicKey: escrow.ephemeralPublicKey,
                    hkdfSalt: escrow.hkdfSalt,
                    keyVersion: escrow.keyVersion,
                    wrapVersion: escrow.wrapVersion,
                  }),
                }
              );
            } catch {
              // Skip failed distributions silently — will retry on next poll
            }
          }
        } catch {
          // Skip failed team — will retry on next poll
        } finally {
          teamKeyBytes?.fill(0);
        }
      }
    } catch {
      // Silently fail — will retry on next poll
    } finally {
      ecdhPrivateKeyBytes.fill(0);
    }
  }, [getEcdhPrivateKeyBytes, getUserId]);

  // Locking the vault drops every unwrapped key: the provider stays mounted
  // across lock, so nothing else would release them.
  useEffect(() => {
    if (!vaultUnlocked) clearAll();
  }, [vaultUnlocked, clearAll]);

  // ─── Periodic auto key distribution (same pattern as EA auto-confirm) ──
  useEffect(() => {
    if (!vaultUnlocked || pollingSuspended) return;

    let inFlight = false;

    const run = () => {
      if (inFlight) return;
      inFlight = true;
      distributePendingKeys()
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };

    // Run immediately on unlock
    run();

    const intervalId = setInterval(run, KEY_DISTRIBUTE_INTERVAL_MS);

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
  }, [vaultUnlocked, pollingSuspended, distributePendingKeys]);

  const value: TeamVaultContextValue = {
    getTeamEncryptionKey,
    getTeamKeyInfo,
    getTeamEncryptionKeyForVersion,
    resolveTeamKey,
    getItemEncryptionKey,
    getEntryDecryptionKey,
    getEntryItemKeys,
    invalidateTeamKey,
    clearAll,
    distributePendingKeys,
  };

  return (
    <TeamVaultContext.Provider value={value}>
      {children}
    </TeamVaultContext.Provider>
  );
}
