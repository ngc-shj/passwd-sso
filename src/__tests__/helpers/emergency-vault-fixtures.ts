/**
 * Real-crypto fixtures for the grantee-side emergency vault view. Builds the
 * `/vault` and `/vault/entries` payloads a server would return for a confirmed
 * grant, using the production wrap helpers with fixed test-only key material,
 * so a test drives the real ECDH unwrap and AES-GCM decrypt path end to end.
 */
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { deriveEncryptionKey, encryptData } from "@/lib/crypto/crypto-client";
import {
  createKeyEscrow,
  encryptPrivateKey,
  exportPrivateKey,
  exportPublicKey,
  generateECDHKeyPair,
} from "@/lib/crypto/crypto-emergency";

export const EMERGENCY_GRANT_ID = "grant-1";
export const EMERGENCY_OWNER_ID = "owner-1";
export const EMERGENCY_GRANTEE_ID = "grantee-1";

export interface EmergencyEntrySpec {
  id: string;
  overview: Record<string, unknown>;
  blob: Record<string, unknown>;
  entryType?: string;
  /** 0 = legacy (no AAD); 1 = AAD-bound. */
  aadVersion?: number;
  /** Corrupt the overview auth tag so its decrypt fails. */
  corruptOverview?: boolean;
}

export interface EmergencyVaultFixture {
  /** The grantee's vault encryption key (what useVault() exposes after unlock). */
  granteeEncryptionKey: CryptoKey;
  vaultBody: Record<string, unknown>;
  entriesBody: Record<string, unknown>[];
}

export async function buildEmergencyVaultFixture(
  entries: EmergencyEntrySpec[],
  owner: { name: string | null; email: string | null } = { name: "Alice", email: "alice@example.com" },
): Promise<EmergencyVaultFixture> {
  const granteeEncryptionKey = await deriveEncryptionKey(new Uint8Array(32).fill(0x11));
  const ownerSecretKey = new Uint8Array(32).fill(0x22);
  const ownerEncryptionKey = await deriveEncryptionKey(ownerSecretKey);

  const granteePair = await generateECDHKeyPair();
  const sealedPrivateKey = await encryptPrivateKey(
    await exportPrivateKey(granteePair.privateKey),
    granteeEncryptionKey,
  );
  const escrow = await createKeyEscrow(ownerSecretKey, await exportPublicKey(granteePair.publicKey), {
    grantId: EMERGENCY_GRANT_ID,
    ownerId: EMERGENCY_OWNER_ID,
    granteeId: EMERGENCY_GRANTEE_ID,
    keyVersion: 1,
  });

  const vaultBody = {
    grantId: EMERGENCY_GRANT_ID,
    ownerId: EMERGENCY_OWNER_ID,
    granteeId: EMERGENCY_GRANTEE_ID,
    owner,
    granteeKeyPair: {
      encryptedPrivateKey: sealedPrivateKey.ciphertext,
      privateKeyIv: sealedPrivateKey.iv,
      privateKeyAuthTag: sealedPrivateKey.authTag,
    },
    ownerEphemeralPublicKey: escrow.ownerEphemeralPublicKey,
    encryptedSecretKey: escrow.encryptedSecretKey,
    secretKeyIv: escrow.secretKeyIv,
    secretKeyAuthTag: escrow.secretKeyAuthTag,
    hkdfSalt: escrow.hkdfSalt,
    keyVersion: escrow.keyVersion,
    wrapVersion: escrow.wrapVersion,
  };

  const entriesBody = await Promise.all(
    entries.map(async (spec) => {
      const aadVersion = spec.aadVersion ?? 1;
      const overviewAad =
        aadVersion >= 1 ? buildPersonalEntryAAD(EMERGENCY_OWNER_ID, spec.id, VAULT_TYPE.OVERVIEW) : undefined;
      const blobAad =
        aadVersion >= 1 ? buildPersonalEntryAAD(EMERGENCY_OWNER_ID, spec.id, VAULT_TYPE.BLOB) : undefined;
      const overview = await encryptData(JSON.stringify(spec.overview), ownerEncryptionKey, overviewAad);
      const blob = await encryptData(JSON.stringify(spec.blob), ownerEncryptionKey, blobAad);
      return {
        id: spec.id,
        encryptedBlob: blob.ciphertext,
        blobIv: blob.iv,
        blobAuthTag: blob.authTag,
        encryptedOverview: overview.ciphertext,
        overviewIv: overview.iv,
        overviewAuthTag: spec.corruptOverview ? "00".repeat(16) : overview.authTag,
        keyVersion: 1,
        aadVersion,
        entryType: spec.entryType ?? "LOGIN",
        isFavorite: false,
        isArchived: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      };
    }),
  );

  return { granteeEncryptionKey, vaultBody, entriesBody };
}
