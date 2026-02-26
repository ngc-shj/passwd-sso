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
  unwrapOrgKey,
  deriveOrgEncryptionKey,
  createOrgKeyEscrow,
  type OrgKeyWrapContext,
} from "./crypto-org";
import { apiPath, API_PATH } from "@/lib/constants";

// ─── Types ────────────────────────────────────────────────────

interface CachedOrgKey {
  key: CryptoKey;
  keyVersion: number;
  cachedAt: number;
}

export interface OrgKeyInfo {
  key: CryptoKey;
  keyVersion: number;
}

export interface OrgVaultContextValue {
  /** Get the org encryption key, fetching and unwrapping if not cached. */
  getOrgEncryptionKey: (orgId: string) => Promise<CryptoKey | null>;
  /** Get the org encryption key with its version number. */
  getOrgKeyInfo: (orgId: string) => Promise<OrgKeyInfo | null>;
  /** Invalidate a cached org key (e.g. after key rotation). */
  invalidateOrgKey: (orgId: string) => void;
  /** Clear all cached org keys (e.g. on vault lock). */
  clearAll: () => void;
  /** Distribute org key to pending members (called after vault unlock). */
  distributePendingKeys: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────

const OrgVaultContext = createContext<OrgVaultContextValue | null>(null);

export function useOrgVault(): OrgVaultContextValue {
  const ctx = useContext(OrgVaultContext);
  if (!ctx) {
    throw new Error("useOrgVault must be used within an OrgVaultProvider");
  }
  return ctx;
}

/** Optional accessor — returns null if not inside an OrgVaultProvider. */
export function useOrgVaultOptional(): OrgVaultContextValue | null {
  return useContext(OrgVaultContext);
}

// ─── Constants ────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const KEY_DISTRIBUTE_INTERVAL_MS = 2 * 60 * 1000; // check pending distributions every 2 minutes

// ─── Provider ─────────────────────────────────────────────────

interface OrgVaultProviderProps {
  children: ReactNode;
  getEcdhPrivateKeyBytes: () => Uint8Array | null;
  getUserId: () => string | null;
  vaultUnlocked: boolean;
}

export function OrgVaultProvider({
  children,
  getEcdhPrivateKeyBytes,
  getUserId,
  vaultUnlocked,
}: OrgVaultProviderProps) {
  const cacheRef = useRef<Map<string, CachedOrgKey>>(new Map());

  const clearAll = useCallback(() => {
    cacheRef.current.clear();
  }, []);

  const invalidateOrgKey = useCallback((orgId: string) => {
    cacheRef.current.delete(orgId);
  }, []);

  const getOrgEncryptionKey = useCallback(
    async (orgId: string): Promise<CryptoKey | null> => {
      // Check cache
      const cached = cacheRef.current.get(orgId);
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
        // Fetch own OrgMemberKey
        const res = await fetch(apiPath.teamMemberKey(orgId));
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
        const ctx: OrgKeyWrapContext = {
          orgId,
          toUserId: userId,
          keyVersion: memberKeyData.keyVersion,
          wrapVersion: memberKeyData.wrapVersion,
        };

        // Unwrap org key
        const orgKeyBytes = await unwrapOrgKey(
          {
            ciphertext: memberKeyData.encryptedOrgKey,
            iv: memberKeyData.orgKeyIv,
            authTag: memberKeyData.orgKeyAuthTag,
          },
          memberKeyData.ephemeralPublicKey,
          ecdhPrivateKey,
          memberKeyData.hkdfSalt,
          ctx
        );

        // Derive encryption key from org key, then zero-clear raw bytes
        const encryptionKey = await deriveOrgEncryptionKey(orgKeyBytes);
        orgKeyBytes.fill(0);

        // Cache (always the latest key from server)
        cacheRef.current.set(orgId, {
          key: encryptionKey,
          keyVersion: memberKeyData.keyVersion,
          cachedAt: Date.now(),
        });

        return encryptionKey;
      } catch (e) {
        console.error("[getOrgEncryptionKey]", e instanceof Error ? e.message : "unknown");
        ecdhPrivateKeyBytes.fill(0);
        return null;
      }
    },
    [getEcdhPrivateKeyBytes, getUserId]
  );

  const getOrgKeyInfo = useCallback(
    async (orgId: string): Promise<OrgKeyInfo | null> => {
      const key = await getOrgEncryptionKey(orgId);
      if (!key) return null;
      const cached = cacheRef.current.get(orgId);
      if (!cached) return null;
      return { key, keyVersion: cached.keyVersion };
    },
    [getOrgEncryptionKey]
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

      // Group by orgId for efficiency
      const byOrg = new Map<
        string,
        Array<{
          memberId: string;
          orgId: string;
          userId: string;
          ecdhPublicKey: string | null;
          orgKeyVersion: number;
        }>
      >();
      for (const member of pendingMembers) {
        const list = byOrg.get(member.orgId) ?? [];
        list.push(member);
        byOrg.set(member.orgId, list);
      }

      for (const [orgId, members] of byOrg) {
        let orgKeyBytes: Uint8Array | undefined;
        try {
          // Get own org key first
          const ownKeyRes = await fetch(apiPath.teamMemberKey(orgId));
          if (!ownKeyRes.ok) continue;

          const ownKeyData = await ownKeyRes.json();

          // Build AAD context for own key unwrapping
          const ownCtx: OrgKeyWrapContext = {
            orgId,
            toUserId: userId,
            keyVersion: ownKeyData.keyVersion,
            wrapVersion: ownKeyData.wrapVersion,
          };

          // Unwrap org key
          orgKeyBytes = await unwrapOrgKey(
            {
              ciphertext: ownKeyData.encryptedOrgKey,
              iv: ownKeyData.orgKeyIv,
              authTag: ownKeyData.orgKeyAuthTag,
            },
            ownKeyData.ephemeralPublicKey,
            ecdhPrivateKey,
            ownKeyData.hkdfSalt,
            ownCtx
          );

          // For each pending member, wrap org key with their ECDH public key
          for (const member of members) {
            try {
              if (!member.ecdhPublicKey) continue;

              const escrow = await createOrgKeyEscrow(
                orgKeyBytes,
                member.ecdhPublicKey,
                orgId,
                member.userId,
                member.orgKeyVersion
              );

              // Send to confirm-key endpoint
              await fetch(
                apiPath.teamMemberConfirmKey(orgId, member.memberId),
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    encryptedOrgKey: escrow.encryptedOrgKey,
                    orgKeyIv: escrow.orgKeyIv,
                    orgKeyAuthTag: escrow.orgKeyAuthTag,
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
          // Skip failed org — will retry on next poll
        } finally {
          orgKeyBytes?.fill(0);
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

  const value: OrgVaultContextValue = {
    getOrgEncryptionKey,
    getOrgKeyInfo,
    invalidateOrgKey,
    clearAll,
    distributePendingKeys,
  };

  return (
    <OrgVaultContext.Provider value={value}>
      {children}
    </OrgVaultContext.Provider>
  );
}
