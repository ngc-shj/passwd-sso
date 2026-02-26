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

      try {
        // Fetch own TeamMemberKey
        const res = await fetch(apiPath.teamMemberKey(teamId));
        if (!res.ok) {
          ecdhPrivateKeyBytes.fill(0);
          return null;
        }

        const memberKeyData = await res.json();

        // Import ECDH private key, then zero-clear the copy
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
        const encryptionKey = await deriveTeamEncryptionKey(teamKeyBytes);
        teamKeyBytes.fill(0);

        // Cache (always the latest key from server)
        cacheRef.current.set(teamId, {
          key: encryptionKey,
          keyVersion: memberKeyData.keyVersion,
          cachedAt: Date.now(),
        });

        return encryptionKey;
      } catch (e) {
        console.error("[getTeamEncryptionKey]", e instanceof Error ? e.message : "unknown");
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
