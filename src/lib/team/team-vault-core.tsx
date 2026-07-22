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
  type TeamKeyWrapContext,
} from "../crypto/crypto-team";
import { buildItemKeyWrapAAD } from "../crypto/crypto-aad";
import { apiPath, API_PATH } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { fetchApi } from "@/lib/url-helpers";

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

interface CachedItemKey {
  key: CryptoKey;
  cachedAt: number;
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
  teamKeyVersion: number;
}

export interface TeamVaultContextValue {
  /** Get the team encryption key, fetching and unwrapping if not cached. */
  getTeamEncryptionKey: (teamId: string) => Promise<CryptoKey | null>;
  /** Get the team encryption key with its version number. */
  getTeamKeyInfo: (teamId: string) => Promise<TeamKeyInfo | null>;
  /** Get a specific (possibly non-latest) team encryption key version, e.g. for old history rows. */
  getTeamEncryptionKeyForVersion: (teamId: string, keyVersion: number) => Promise<CryptoKey | null>;
  /** Get the per-entry ItemKey-derived encryption key for attachment operations. */
  getItemEncryptionKey: (teamId: string, entryId: string) => Promise<CryptoKey>;
  /** Get the correct decryption key for an entry (ItemKey-derived if v>=1, TeamKey if v0). */
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>;
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

/** Thrown by getEntryDecryptionKey when a versioned TeamKey fetch fails
 * (member-key 404, or server returned a different keyVersion than requested).
 * Lets callers (e.g. history view) show a distinct "key unavailable" message
 * instead of the generic decrypt-failure toast. */
export class TeamKeyVersionUnavailableError extends Error {
  constructor(teamId: string, keyVersion: number) {
    super(`Team key version ${keyVersion} unavailable for team ${teamId}`);
    this.name = "TeamKeyVersionUnavailableError";
  }
}

function describeUnknownError(e: unknown): string {
  if (e instanceof Error) {
    const base = e.message ? `${e.name}: ${e.message}` : `${e.name}: <empty message>`;
    return e.cause ? `${base} cause=${String(e.cause)}` : base;
  }
  return String(e);
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

// ─── Provider ─────────────────────────────────────────────────

interface TeamVaultProviderProps {
  children: ReactNode;
  getEcdhPrivateKeyBytes: () => Uint8Array | null;
  getUserId: () => string | null;
  vaultUnlocked: boolean;
}

export function TeamVaultProvider({
  children,
  getEcdhPrivateKeyBytes,
  getUserId,
  vaultUnlocked,
}: TeamVaultProviderProps) {
  // Keyed by `${teamId}:${keyVersion}` for versioned entries, plus a
  // `${teamId}:latest` pointer (LatestPointer) recording which version number
  // is currently "latest" for that team.
  const cacheRef = useRef<Map<string, CachedTeamKey | LatestPointer>>(new Map());
  const itemKeyCacheRef = useRef<Map<string, Map<string, CachedItemKey>>>(new Map());

  const clearAll = useCallback(() => {
    cacheRef.current.clear();
    itemKeyCacheRef.current.clear();
  }, []);

  const invalidateTeamKey = useCallback((teamId: string) => {
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
  const fetchAndUnwrapTeamKey = useCallback(
    async (
      teamId: string,
      requestedVersion?: number
    ): Promise<{ key: CryptoKey; keyVersion: number } | null> => {
      const ecdhPrivateKeyBytes = getEcdhPrivateKeyBytes();
      const userId = getUserId();
      if (!ecdhPrivateKeyBytes || !userId) {
        return null;
      }

      let stage = "fetch_member_key";
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
          console.warn("[getTeamEncryptionKey] member-key request failed", {
            teamId,
            status: res.status,
            error: errorCode,
          });
          ecdhPrivateKeyBytes.fill(0);
          return null;
        }

        stage = "parse_member_key";
        const memberKeyData = parseTeamMemberKeyResponse(await res.json());

        // Version assertion: a server-side version swap must not poison the
        // versioned slot or the latest pointer.
        if (requestedVersion !== undefined && memberKeyData.keyVersion !== requestedVersion) {
          console.warn("[getTeamEncryptionKey] member-key response version mismatch", {
            teamId,
            requestedVersion,
            responseVersion: memberKeyData.keyVersion,
          });
          ecdhPrivateKeyBytes.fill(0);
          return null;
        }

        // Import ECDH private key, then zero-clear the copy
        stage = "import_ecdh_private_key";
        const keyBuf = ecdhPrivateKeyBytes.buffer.slice(
          ecdhPrivateKeyBytes.byteOffset,
          ecdhPrivateKeyBytes.byteOffset + ecdhPrivateKeyBytes.byteLength
        ) as ArrayBuffer;
        const ecdhPrivateKey = await crypto.subtle.importKey(
          "pkcs8",
          keyBuf,
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
        stage = "unwrap_team_key";
        const teamKeyBytes = await unwrapTeamKey(
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

        // Derive encryption key from team key, then zero-clear raw bytes
        stage = "derive_team_encryption_key";
        const encryptionKey = await deriveTeamEncryptionKey(teamKeyBytes);
        teamKeyBytes.fill(0);

        return { key: encryptionKey, keyVersion: memberKeyData.keyVersion };
      } catch (e) {
        const errorText = describeUnknownError(e);
        console.error(
          `[getTeamEncryptionKey] failed teamId=${teamId} stage=${stage} error=${errorText}`
        );
        ecdhPrivateKeyBytes.fill(0);
        return null;
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

      const resolved = await fetchAndUnwrapTeamKey(teamId);
      if (!resolved) return null;

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

  const getTeamEncryptionKeyForVersion = useCallback(
    async (teamId: string, keyVersion: number): Promise<CryptoKey | null> => {
      const cacheKey = `${teamId}:${keyVersion}`;
      const cached = cacheRef.current.get(cacheKey) as CachedTeamKey | undefined;
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.key;
      }

      const resolved = await fetchAndUnwrapTeamKey(teamId, keyVersion);
      if (!resolved) return null;

      // Versioned (non-latest) fetches never write the latest pointer slot.
      cacheRef.current.set(cacheKey, {
        key: resolved.key,
        keyVersion: resolved.keyVersion,
        cachedAt: Date.now(),
      });

      return resolved.key;
    },
    [fetchAndUnwrapTeamKey]
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

  const getItemEncryptionKey = useCallback(
    async (teamId: string, entryId: string): Promise<CryptoKey> => {
      // Check cache
      const teamCache = itemKeyCacheRef.current.get(teamId);
      const cached = teamCache?.get(entryId);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.key;
      }

      // Fetch entry to get ItemKey metadata
      const res = await fetchApi(apiPath.teamPasswordById(teamId, entryId));
      if (!res.ok) {
        throw new Error(`Failed to fetch entry ItemKey data (status=${res.status})`);
      }
      const raw = await res.json();

      const itemKeyVersion = typeof raw.itemKeyVersion === "number" ? raw.itemKeyVersion : 0;
      if (
        itemKeyVersion < 1 ||
        typeof raw.encryptedItemKey !== "string" ||
        typeof raw.itemKeyIv !== "string" ||
        typeof raw.itemKeyAuthTag !== "string" ||
        typeof raw.teamKeyVersion !== "number"
      ) {
        throw new Error("Entry does not have ItemKey (itemKeyVersion < 1). Cannot encrypt attachments.");
      }

      // Get TeamKey to unwrap ItemKey
      const teamKey = await getTeamEncryptionKey(teamId);
      if (!teamKey) {
        throw new Error("Failed to obtain team encryption key for ItemKey unwrap");
      }

      // Build AAD and unwrap
      const ikAad = buildItemKeyWrapAAD(teamId, entryId, raw.teamKeyVersion);
      const rawItemKey = await unwrapItemKey(
        {
          ciphertext: raw.encryptedItemKey,
          iv: raw.itemKeyIv,
          authTag: raw.itemKeyAuthTag,
        },
        teamKey,
        ikAad,
      );

      // Derive encryption key from ItemKey
      const encryptionKey = await deriveItemEncryptionKey(rawItemKey);
      rawItemKey.fill(0);

      // Cache
      if (!itemKeyCacheRef.current.has(teamId)) {
        itemKeyCacheRef.current.set(teamId, new Map());
      }
      itemKeyCacheRef.current.get(teamId)!.set(entryId, {
        key: encryptionKey,
        cachedAt: Date.now(),
      });

      return encryptionKey;
    },
    [getTeamEncryptionKey]
  );

  const getEntryDecryptionKey = useCallback(
    async (teamId: string, entryId: string, entry: EntryItemKeyData): Promise<CryptoKey> => {
      const itemKeyVersion = entry.itemKeyVersion ?? 0;

      // Normalize: legacy schema-default-0 rows (column added with DEFAULT 0,
      // no backfill) were sealed under what became version 1 — `<1 -> 1`,
      // NOT `?? 1` alone, since `0 ?? 1 === 0`.
      const rawTeamKeyVersion = entry.teamKeyVersion;
      const normalizedTeamKeyVersion = rawTeamKeyVersion < 1 ? 1 : rawTeamKeyVersion;

      const keyInfo = await getTeamKeyInfo(teamId);
      if (!keyInfo) {
        throw new Error("Failed to obtain team encryption key");
      }

      const isLatest = normalizedTeamKeyVersion === keyInfo.keyVersion;
      const teamKey = isLatest
        ? keyInfo.key
        : await getTeamEncryptionKeyForVersion(teamId, normalizedTeamKeyVersion);
      if (!teamKey) {
        throw new TeamKeyVersionUnavailableError(teamId, normalizedTeamKeyVersion);
      }

      // v0: use the (possibly old) TeamKey directly. Raw-0 rows predate
      // ItemKey mode entirely, so there is no ItemKey unwrap here regardless
      // of which TeamKey version was resolved.
      if (itemKeyVersion < 1) {
        return teamKey;
      }

      // v>=1: check cache first — but only for the latest version. Versioned
      // (non-latest) ItemKey unwraps are never cached, to avoid cross-version
      // contamination in itemKeyCacheRef (keyed by entryId only).
      if (isLatest) {
        const teamCache = itemKeyCacheRef.current.get(teamId);
        const cached = teamCache?.get(entryId);
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return cached.key;
        }
      }

      // Validate required fields
      if (
        typeof entry.encryptedItemKey !== "string" ||
        typeof entry.itemKeyIv !== "string" ||
        typeof entry.itemKeyAuthTag !== "string"
      ) {
        throw new Error("Entry has itemKeyVersion >= 1 but missing ItemKey encryption data");
      }

      // AAD uses the entry's raw teamKeyVersion as recorded at wrap time —
      // NOT the normalized value — to match what the server used when
      // wrapping this row's ItemKey. (Raw-0 rows never reach here: they
      // return above at the itemKeyVersion < 1 check, since a schema-default
      // teamKeyVersion of 0 predates ItemKey mode entirely.)
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

      // Derive encryption key and zero-clear raw bytes
      const encryptionKey = await deriveItemEncryptionKey(rawItemKey);
      rawItemKey.fill(0);

      if (!isLatest) {
        return encryptionKey;
      }

      // Cache (latest version only)
      if (!itemKeyCacheRef.current.has(teamId)) {
        itemKeyCacheRef.current.set(teamId, new Map());
      }
      itemKeyCacheRef.current.get(teamId)!.set(entryId, {
        key: encryptionKey,
        cachedAt: Date.now(),
      });

      return encryptionKey;
    },
    [getTeamKeyInfo, getTeamEncryptionKeyForVersion]
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

      // Import ECDH private key for unwrapping, then zero-clear the copy
      const privKeyBuf = ecdhPrivateKeyBytes.buffer.slice(
        ecdhPrivateKeyBytes.byteOffset,
        ecdhPrivateKeyBytes.byteOffset + ecdhPrivateKeyBytes.byteLength
      ) as ArrayBuffer;
      const ecdhPrivateKey = await crypto.subtle.importKey(
        "pkcs8",
        privKeyBuf,
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

  // ─── Periodic auto key distribution (same pattern as EA auto-confirm) ──
  useEffect(() => {
    if (!vaultUnlocked) return;

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
  }, [vaultUnlocked, distributePendingKeys]);

  const value: TeamVaultContextValue = {
    getTeamEncryptionKey,
    getTeamKeyInfo,
    getTeamEncryptionKeyForVersion,
    getItemEncryptionKey,
    getEntryDecryptionKey,
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
