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
  type TeamKeyWrapContext,
} from "./crypto-team";
import { apiPath, API_PATH } from "@/lib/constants";

// ─── Types ────────────────────────────────────────────────────

interface CachedTeamKey {
  key: CryptoKey;
  keyVersion: number;
  cachedAt: number;
}

export interface TeamKeyInfo {
  key: CryptoKey;
  keyVersion: number;
}

export interface TeamVaultContextValue {
  /** Get the team encryption key, fetching and unwrapping if not cached. */
  getTeamEncryptionKey: (teamId: string) => Promise<CryptoKey | null>;
  /** Get the team encryption key with its version number. */
  getTeamKeyInfo: (teamId: string) => Promise<TeamKeyInfo | null>;
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

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const KEY_DISTRIBUTE_INTERVAL_MS = 2 * 60 * 1000; // check pending distributions every 2 minutes

type TeamMemberKeyResponse = {
  encryptedTeamKey: string;
  teamKeyIv: string;
  teamKeyAuthTag: string;
  ephemeralPublicKey: string;
  hkdfSalt: string;
  keyVersion: number;
  wrapVersion: number;
};

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
  const cacheRef = useRef<Map<string, CachedTeamKey>>(new Map());

  const clearAll = useCallback(() => {
    cacheRef.current.clear();
  }, []);

  const invalidateTeamKey = useCallback((teamId: string) => {
    cacheRef.current.delete(teamId);
  }, []);

  const getTeamEncryptionKey = useCallback(
    async (teamId: string): Promise<CryptoKey | null> => {
      // Check cache
      const cached = cacheRef.current.get(teamId);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.key;
      }

      // Get ECDH private key from VaultContext
      const ecdhPrivateKeyBytes = getEcdhPrivateKeyBytes();
      const userId = getUserId();
      if (!ecdhPrivateKeyBytes || !userId) {
        return null;
      }

      let stage = "fetch_member_key";
      try {
        // Fetch own TeamMemberKey
        const res = await fetch(apiPath.teamMemberKey(teamId));
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

        // Build AAD context for unwrapping
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

        // Cache (always the latest key from server)
        stage = "cache_team_key";
        cacheRef.current.set(teamId, {
          key: encryptionKey,
          keyVersion: memberKeyData.keyVersion,
          cachedAt: Date.now(),
        });

        return encryptionKey;
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

  const getTeamKeyInfo = useCallback(
    async (teamId: string): Promise<TeamKeyInfo | null> => {
      const key = await getTeamEncryptionKey(teamId);
      if (!key) return null;
      const cached = cacheRef.current.get(teamId);
      if (!cached) return null;
      return { key, keyVersion: cached.keyVersion };
    },
    [getTeamEncryptionKey]
  );

  const distributePendingKeys = useCallback(async () => {
    const ecdhPrivateKeyBytes = getEcdhPrivateKeyBytes();
    const userId = getUserId();
    if (!ecdhPrivateKeyBytes || !userId) return;

    try {
      // Fetch pending key distributions
      const res = await fetch(API_PATH.TEAMS_PENDING_KEY_DISTRIBUTIONS);
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
          const ownKeyRes = await fetch(apiPath.teamMemberKey(teamId));
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
              await fetch(
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
