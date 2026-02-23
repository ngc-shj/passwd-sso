"use client";

import {
  createContext,
  useContext,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  unwrapOrgKey,
  deriveOrgEncryptionKey,
  createOrgKeyEscrow,
  hexEncode,
  CURRENT_ORG_WRAP_VERSION,
  type OrgKeyWrapContext,
} from "./crypto-org";
import { apiPath, API_PATH } from "@/lib/constants";

// ─── Types ────────────────────────────────────────────────────

interface CachedOrgKey {
  key: CryptoKey;
  keyVersion: number;
  cachedAt: number;
}

export interface OrgVaultContextValue {
  /** Get the org encryption key, fetching and unwrapping if not cached. */
  getOrgEncryptionKey: (orgId: string) => Promise<CryptoKey | null>;
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

// ─── Provider ─────────────────────────────────────────────────

interface OrgVaultProviderProps {
  children: ReactNode;
  getEcdhPrivateKeyBytes: () => Uint8Array | null;
  getUserId: () => string | null;
}

export function OrgVaultProvider({
  children,
  getEcdhPrivateKeyBytes,
  getUserId,
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
        const res = await fetch(apiPath.orgMemberKey(orgId));
        if (!res.ok) {
          return null;
        }

        const memberKeyData = await res.json();

        // Import ECDH private key
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
          orgId,
          ctx
        );

        // Derive encryption key from org key
        const encryptionKey = await deriveOrgEncryptionKey(orgKeyBytes);

        // Cache
        cacheRef.current.set(orgId, {
          key: encryptionKey,
          keyVersion: memberKeyData.keyVersion,
          cachedAt: Date.now(),
        });

        // Check if cached version matches server version (key rotation detection)
        if (cached && cached.keyVersion !== memberKeyData.keyVersion) {
          // Key was rotated — re-fetch
          cacheRef.current.delete(orgId);
          return getOrgEncryptionKey(orgId);
        }

        return encryptionKey;
      } catch {
        return null;
      }
    },
    [getEcdhPrivateKeyBytes, getUserId]
  );

  const distributePendingKeys = useCallback(async () => {
    const ecdhPrivateKeyBytes = getEcdhPrivateKeyBytes();
    const userId = getUserId();
    if (!ecdhPrivateKeyBytes || !userId) return;

    try {
      // Fetch pending key distributions
      const res = await fetch(API_PATH.ORGS_PENDING_KEY_DISTRIBUTIONS);
      if (!res.ok) return;

      const pendingMembers = await res.json();
      if (!Array.isArray(pendingMembers) || pendingMembers.length === 0) return;

      // Import ECDH private key for unwrapping
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
        try {
          // Get own org key first
          const ownKeyRes = await fetch(apiPath.orgMemberKey(orgId));
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
          const orgKeyBytes = await unwrapOrgKey(
            {
              ciphertext: ownKeyData.encryptedOrgKey,
              iv: ownKeyData.orgKeyIv,
              authTag: ownKeyData.orgKeyAuthTag,
            },
            ownKeyData.ephemeralPublicKey,
            ecdhPrivateKey,
            orgId,
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
                apiPath.orgMemberConfirmKey(orgId, member.memberId),
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
                  }),
                }
              );
            } catch {
              // Skip failed distributions silently — will retry on next poll
            }
          }
        } catch {
          // Skip failed org — will retry on next poll
        }
      }
    } catch {
      // Silently fail — will retry on next poll
    }
  }, [getEcdhPrivateKeyBytes, getUserId]);

  const value: OrgVaultContextValue = {
    getOrgEncryptionKey,
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
