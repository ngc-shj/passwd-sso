/**
 * Database helper for seeding PasswordShare (share link) rows in E2E tests.
 *
 * The encrypted_data field is encrypted with the SHARE_MASTER_KEY from env,
 * replicating the logic in src/lib/crypto-server.ts encryptShareData().
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { E2E_TENANT, getPool } from "./db";

function getShareMasterKey(): Buffer {
  // Prefer versioned key, fall back to legacy SHARE_MASTER_KEY
  const hex =
    process.env.SHARE_MASTER_KEY_V1?.trim() ||
    process.env.SHARE_MASTER_KEY?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      "SHARE_MASTER_KEY_V1 or SHARE_MASTER_KEY must be set (64-char hex)"
    );
  }
  return Buffer.from(hex, "hex");
}

function encryptWithMasterKey(
  plaintext: string
): { ciphertext: string; iv: string; authTag: string } {
  const key = getShareMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

export interface SeedShareLinkOptions {
  createdById: string;
  tenantId?: string;
  entryId: string;
  /** Title to include in the encrypted share data snapshot */
  title?: string;
}

/**
 * Seed a share link for a password entry.
 * Returns the raw 64-char hex token so tests can navigate to /s/<token>.
 */
export async function seedShareLink(
  options: SeedShareLinkOptions
): Promise<string> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const now = new Date().toISOString();

  // Generate a random 32-byte token (64-char hex)
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // Encrypt a snapshot of the entry data using the server master key
  const shareDataPayload = JSON.stringify({
    title: options.title ?? "E2E Shared Entry",
    username: "e2e-user@example.com",
    password: "E2ESeedPassword!999",
    url: "https://example.com",
    notes: "Seeded by E2E global-setup",
    entryType: "LOGIN",
  });
  const encrypted = encryptWithMasterKey(shareDataPayload);

  // Expires 24 hours from now
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await p.query(
    `INSERT INTO password_shares (
      id, tenant_id, token_hash, share_type, entry_type,
      encrypted_data, data_iv, data_auth_tag,
      expires_at, master_key_version,
      password_entry_id, created_by_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (token_hash) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      share_type = EXCLUDED.share_type,
      entry_type = EXCLUDED.entry_type,
      encrypted_data = EXCLUDED.encrypted_data,
      data_iv = EXCLUDED.data_iv,
      data_auth_tag = EXCLUDED.data_auth_tag,
      expires_at = EXCLUDED.expires_at,
      master_key_version = EXCLUDED.master_key_version,
      password_entry_id = EXCLUDED.password_entry_id,
      created_by_id = EXCLUDED.created_by_id`,
    [
      crypto.randomUUID(),
      tenantId,
      tokenHash,
      "ENTRY_SHARE", // share_type
      "LOGIN", // entry_type
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      expiresAt,
      1, // master_key_version
      options.entryId,
      options.createdById,
      now,
    ]
  );

  return rawToken;
}
