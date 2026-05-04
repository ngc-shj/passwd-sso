/**
 * Database helper for seeding PasswordEntry rows in E2E tests.
 *
 * Entry data is AES-256-GCM encrypted using the same key the user's vault
 * was set up with, so the browser can decrypt it after vault unlock.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { aesGcmEncrypt } from "./crypto";
import { E2E_TENANT, getPool } from "./db";
import {
  buildAttachmentAAD,
  buildAttachmentCekWrapAAD,
} from "@/lib/crypto/crypto-aad";
import { encryptBinary } from "@/lib/crypto/crypto-client";

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
  /** UUIDv4 row id — generated client-side so AAD can be computed before insert. */
  id?: string;
  /** Owning password entry id (must already exist). */
  passwordEntryId: string;
  /** Tenant the entry belongs to (defaults to E2E_TENANT.id). */
  tenantId?: string;
  /** User id of the entry owner (created_by_id on the row). */
  createdById: string;
  /** Filename to surface in the UI (default: "e2e-seed.txt"). */
  filename?: string;
  /**
   * Plaintext bytes to encrypt. When provided together with encryptionKey,
   * real AES-GCM ciphertext is produced so round-trip decryption works.
   * When omitted, random placeholder bytes are used (mode-0 only).
   */
  plaintext?: Buffer;
  /**
   * User vault secret key (CryptoKey) used for mode-0 direct encryption and
   * for mode-2 CEK wrapping. Required when plaintext is provided or when
   * encryptionMode is 2.
   */
  encryptionKey?: CryptoKey;
  /**
   * Encryption mode:
   *   0 = direct vault key encryption (legacy, default)
   *   2 = CEK indirection (Phase B)
   * Mode 1 (team) is out of scope for this helper.
   */
  encryptionMode?: 0 | 2;
  /**
   * Key version to record in cek_key_version (mode-2 only).
   * Defaults to 1.
   */
  cekKeyVersion?: number;
  /**
   * CEK wrap AAD version (mode-2 only). Defaults to 1.
   */
  cekWrapAadVersion?: number;
}

export interface SeedAttachmentResult {
  /** The UUIDv4 assigned to the attachment row. */
  id: string;
}

/**
 * Seed an Attachment row for E2E / integration tests of the personal-entry
 * attachment flow (#433/A.4, Phase B #437).
 *
 * When plaintext + encryptionKey are provided the helper produces real
 * AES-GCM ciphertext using the production AAD builders from
 * @/lib/crypto/crypto-aad — so round-trip decryption works in Phase B
 * integration tests without ever defining a local copy of the AAD logic
 * (T21: NEVER redefine crypto-aad locally; import from production module).
 *
 * Mode-0 path:
 *   - body encrypted under encryptionKey with AAD = buildAttachmentAAD(entryId, attachmentId)
 *
 * Mode-2 path:
 *   - fresh CEK generated; body encrypted under CEK with body AAD
 *   - CEK raw bytes wrapped under encryptionKey with AAD =
 *     buildAttachmentCekWrapAAD(entryId, attachmentId, cekKeyVersion, cekWrapAadVersion)
 *   - CEK wrap uses manual exportKey("raw") + AES-GCM (not SubtleCrypto wrapKey)
 *     to keep the cek_iv and cek_auth_tag explicit for DB storage
 *
 * Existing E2E callers that only pass {id, passwordEntryId, createdById} still
 * work — they get random placeholder bytes in mode-0 (same as before Phase B).
 */
export async function seedAttachment(
  options: SeedAttachmentOptions,
): Promise<SeedAttachmentResult> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const filename = options.filename ?? "e2e-seed.txt";
  const encryptionMode = options.encryptionMode ?? 0;
  const cekKeyVersion = options.cekKeyVersion ?? 1;
  const cekWrapAadVersion = options.cekWrapAadVersion ?? 1;
  const now = new Date().toISOString();

  // Resolve attachment ID before encryption so AAD can include it.
  const attachmentId = options.id ?? randomUUID();
  const entryId = options.passwordEntryId;

  let encryptedData: Buffer;
  let iv: string;
  let authTag: string;
  // Mode-2 CEK columns (null for mode-0)
  let cekEncrypted: Buffer | null = null;
  let cekIv: string | null = null;
  let cekAuthTag: string | null = null;

  const usesRealCrypto = options.plaintext !== undefined && options.encryptionKey !== undefined;

  if (usesRealCrypto && encryptionMode === 0) {
    // Real mode-0: encrypt plaintext under the vault encryption key
    const aad = buildAttachmentAAD(entryId, attachmentId);
    const result = await encryptBinary(
      options.plaintext!.buffer as ArrayBuffer,
      options.encryptionKey!,
      aad,
    );
    encryptedData = Buffer.from(result.ciphertext);
    iv = result.iv;
    authTag = result.authTag;
  } else if (usesRealCrypto && encryptionMode === 2) {
    // Real mode-2: fresh CEK, encrypt body under CEK, wrap CEK under vault key
    const cek = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true, // extractable — needed for exportKey("raw") CEK wrap
      ["encrypt", "decrypt"],
    );

    const bodyAad = buildAttachmentAAD(entryId, attachmentId);
    const bodyResult = await encryptBinary(
      options.plaintext!.buffer as ArrayBuffer,
      cek,
      bodyAad,
    );
    encryptedData = Buffer.from(bodyResult.ciphertext);
    iv = bodyResult.iv;
    authTag = bodyResult.authTag;

    // Wrap CEK: exportKey("raw") + manual AES-GCM under vault key
    const rawCek = await crypto.subtle.exportKey("raw", cek);
    const wrapAad = buildAttachmentCekWrapAAD(
      entryId,
      attachmentId,
      cekKeyVersion,
      cekWrapAadVersion,
    );
    const wrapResult = await encryptBinary(
      rawCek,
      options.encryptionKey!,
      wrapAad,
    );
    cekEncrypted = Buffer.from(wrapResult.ciphertext);
    cekIv = wrapResult.iv;
    cekAuthTag = wrapResult.authTag;
  } else {
    // Placeholder random bytes (legacy mode-0, no real decryptable content)
    encryptedData = randomBytes(64);
    iv = randomBytes(12).toString("hex");
    authTag = randomBytes(16).toString("hex");
  }

  await p.query(
    `INSERT INTO attachments (
      id, password_entry_id, tenant_id, created_by_id,
      filename, content_type, size_bytes,
      encrypted_data, iv, auth_tag,
      cek_encrypted, cek_iv, cek_auth_tag,
      key_version, cek_key_version, cek_wrap_aad_version,
      aad_version, encryption_mode,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    ON CONFLICT (id) DO NOTHING`,
    [
      attachmentId,
      entryId,
      tenantId,
      options.createdById,
      filename,
      "text/plain",
      encryptedData.length,
      encryptedData,
      iv,
      authTag,
      cekEncrypted,
      cekIv,
      cekAuthTag,
      1,              // key_version
      encryptionMode === 2 ? cekKeyVersion : null,
      encryptionMode === 2 ? cekWrapAadVersion : null,
      1,              // aad_version (#433: route requires exactly 1)
      encryptionMode, // encryption_mode
      now,
    ],
  );

  return { id: attachmentId };
}
