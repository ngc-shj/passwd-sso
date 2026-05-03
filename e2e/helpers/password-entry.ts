/**
 * Database helper for seeding PasswordEntry rows in E2E tests.
 *
 * Entry data is AES-256-GCM encrypted using the same key the user's vault
 * was set up with, so the browser can decrypt it after vault unlock.
 */
import { randomBytes } from "node:crypto";
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
    username: "e2e-seeded@example.com",
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
    username: "e2e-seeded@example.com",
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

export interface SeedAttachmentOptions {
  /** UUIDv4 row id. */
  id: string;
  /** Owning password entry id (must already exist). */
  passwordEntryId: string;
  /** Tenant the entry belongs to (defaults to E2E_TENANT.id). */
  tenantId?: string;
  /** User id of the entry owner (created_by_id on the row). */
  createdById: string;
  /** Filename to surface in the UI (default: "e2e-seed.txt"). */
  filename?: string;
}

/**
 * Seed an Attachment row for E2E tests of the personal-entry attachment flow
 * (#433/A.4). The encrypted bytes here are placeholder random data — the test
 * scenarios verify the row is COUNTED + the user-facing acknowledge step
 * fires, not that the bytes decrypt cleanly. After rotation, downloads of
 * such rows are intentionally unrecoverable (Phase B will add CEK
 * indirection — see issue #437).
 *
 * Mirrors the columns required by `POST /api/passwords/[id]/attachments`
 * (encryptedData / iv / authTag / aadVersion=1 / encryptionMode=0).
 */
export async function seedAttachment(
  options: SeedAttachmentOptions,
): Promise<void> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const filename = options.filename ?? "e2e-seed.txt";
  const now = new Date().toISOString();

  // Placeholder encrypted bytes — content does not need to be decryptable
  // for the rotation-side count + acknowledge-flow assertions in #433.
  const encryptedData = randomBytes(64);
  const iv = randomBytes(12).toString("hex");
  const authTag = randomBytes(16).toString("hex");

  await p.query(
    `INSERT INTO attachments (
      id, password_entry_id, tenant_id, created_by_id,
      filename, content_type, size_bytes,
      encrypted_data, iv, auth_tag,
      key_version, aad_version, encryption_mode,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (id) DO NOTHING`,
    [
      options.id,
      options.passwordEntryId,
      tenantId,
      options.createdById,
      filename,
      "text/plain",
      encryptedData.length,
      encryptedData,
      iv,
      authTag,
      1, // key_version
      1, // aad_version (#433: route requires exactly 1)
      0, // encryption_mode (0 = direct vault key wrap, the personal-entry default)
      now,
    ],
  );
}
