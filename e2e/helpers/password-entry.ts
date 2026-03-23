/**
 * Database helper for seeding PasswordEntry rows in E2E tests.
 *
 * Entry data is AES-256-GCM encrypted using the same key the user's vault
 * was set up with, so the browser can decrypt it after vault unlock.
 */
import { aesGcmEncrypt } from "./crypto";
import { E2E_TENANT, getPool } from "./db";

export interface SeedPasswordEntryOptions {
  id: string;
  userId: string;
  tenantId?: string;
  title: string;
  encryptionKey: Buffer; // from setupVaultCrypto().encryptionKey
}

export async function seedPasswordEntry(
  options: SeedPasswordEntryOptions
): Promise<void> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const now = new Date().toISOString();

  // Encrypt the full entry blob (all sensitive fields)
  const blobData = {
    title: options.title,
    username: "e2e-user@example.com",
    password: "E2ESeedPassword!999",
    url: "https://example.com",
    notes: "Seeded by E2E global-setup",
  };
  const blob = aesGcmEncrypt(
    options.encryptionKey,
    Buffer.from(JSON.stringify(blobData))
  );

  // Encrypt the overview blob (summary for list view)
  const overviewData = {
    title: options.title,
    username: "e2e-user@example.com",
    urlHost: "example.com",
    tags: [],
  };
  const overview = aesGcmEncrypt(
    options.encryptionKey,
    Buffer.from(JSON.stringify(overviewData))
  );

  await p.query(
    `INSERT INTO password_entries (
      id, user_id, tenant_id,
      encrypted_blob, blob_iv, blob_auth_tag,
      encrypted_overview, overview_iv, overview_auth_tag,
      key_version, entry_type,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      tenant_id = EXCLUDED.tenant_id,
      encrypted_blob = EXCLUDED.encrypted_blob,
      blob_iv = EXCLUDED.blob_iv,
      blob_auth_tag = EXCLUDED.blob_auth_tag,
      encrypted_overview = EXCLUDED.encrypted_overview,
      overview_iv = EXCLUDED.overview_iv,
      overview_auth_tag = EXCLUDED.overview_auth_tag,
      key_version = EXCLUDED.key_version,
      entry_type = EXCLUDED.entry_type,
      updated_at = EXCLUDED.updated_at`,
    [
      options.id,
      options.userId,
      tenantId,
      blob.ciphertext,
      blob.iv,
      blob.authTag,
      overview.ciphertext,
      overview.iv,
      overview.authTag,
      1, // key_version
      "LOGIN", // entry_type
      now,
      now,
    ]
  );
}
