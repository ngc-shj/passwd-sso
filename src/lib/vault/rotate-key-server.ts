import type { Prisma } from "@prisma/client";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { markGrantsStaleForOwner } from "@/lib/emergency-access/emergency-access-server";
import {
  ATTACHMENT_MANIFEST_CAP,
} from "@/lib/validations/common";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";

// ── Error classes ────────────────────────────────────────────────────────────

/** Rotation attempted while mode-0 attachment rows still exist for the user. */
export class LegacyAttachmentsResidualError extends Error {
  constructor() {
    super("LEGACY_ATTACHMENTS_RESIDUAL");
    this.name = "LegacyAttachmentsResidualError";
  }
}

/** Client manifest references attachment IDs that do not match the server set. */
export class AttachmentCekManifestMismatchError extends Error {
  constructor() {
    super("ATTACHMENT_CEK_MANIFEST_MISMATCH");
    this.name = "AttachmentCekManifestMismatchError";
  }
}

/**
 * A manifest attachment's current cekKeyVersion does not match the old key
 * version expected at rotation time.
 */
export class LegacyAttachmentInconsistentVersionError extends Error {
  constructor() {
    super("ATTACHMENT_INCONSISTENT_VERSION");
    this.name = "LegacyAttachmentInconsistentVersionError";
  }
}

/**
 * Post-write sanity check failed — some mode-2 attachments still have the
 * old cekKeyVersion. Transaction must be rolled back.
 */
export class RotationPostConditionError extends Error {
  constructor() {
    super("ROTATION_POST_CONDITION_FAILED");
    this.name = "RotationPostConditionError";
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AttachmentCekRewrap {
  id: string;
  cekEncrypted: string; // base64
  cekIv: string;        // hex 24 chars
  cekAuthTag: string;   // hex 32 chars
  cekKeyVersion: number;
  cekWrapAadVersion: number;
}

export interface RotationPayload {
  encryptedSecretKey: string;
  secretKeyIv: string;
  secretKeyAuthTag: string;
  accountSalt: string;
  newAuthHash: string;
  newVerifierHash?: string;
  verificationArtifact: { ciphertext: string; iv: string; authTag: string };
  entries: Array<{
    id: string;
    encryptedBlob: { ciphertext: string; iv: string; authTag: string };
    encryptedOverview: { ciphertext: string; iv: string; authTag: string };
    aadVersion: number;
  }>;
  historyEntries: Array<{
    id: string;
    encryptedBlob: { ciphertext: string; iv: string; authTag: string };
    aadVersion: number;
  }>;
  encryptedEcdhPrivateKey: string;
  ecdhPrivateKeyIv: string;
  ecdhPrivateKeyAuthTag: string;
  attachmentCekRewraps: AttachmentCekRewrap[];
  legacyAttachmentsMigratedThisCycle?: number;
}

export interface RotationEffects {
  recoveryKeyInvalidated: boolean;
  emergencyGrantsCleared: number;
  prfCredentialsCleared: number;
  cekRewrapsAttempted: number;
  cekRewrapsSucceeded: number;
  cekRewrapsFailed: number;
  legacyAttachmentsMigratedClientReported: number;
  mode0Residual: 0;
  cekRewrappedAttachmentIds: string[];
  cekRewrappedAttachmentIdsOverflow: boolean;
}

// ── applyVaultRotation ───────────────────────────────────────────────────────

/**
 * Encapsulates the transactional body of personal vault key rotation.
 *
 * The caller is responsible for:
 *   - session auth + passphrase verification
 *   - advisory lock: `SELECT pg_advisory_xact_lock(hashtext(userId))`
 *   - wrapping this call in `prisma.$transaction(async (tx) => { ... })`
 *   - mapping error classes to HTTP responses
 *
 * @param tx          - Prisma interactive transaction client (with RLS set)
 * @param userId      - Authenticated user ID
 * @param tenantId    - Tenant ID from user record
 * @param oldKeyVersion - Current (pre-rotation) keyVersion from user record
 * @param newKeyVersion - Target keyVersion (oldKeyVersion + 1, computed by caller)
 * @param newServerHash - Pre-computed PBKDF2+salt hash of newAuthHash
 * @param newServerSalt - Fresh random salt used for newServerHash
 * @param payload     - Validated rotation request payload
 */
export async function applyVaultRotation(
  tx: Prisma.TransactionClient,
  userId: string,
  tenantId: string,
  oldKeyVersion: number,
  newKeyVersion: number,
  newServerHash: string,
  newServerSalt: string,
  payload: RotationPayload,
): Promise<RotationEffects> {
  const {
    entries,
    historyEntries,
    encryptedEcdhPrivateKey,
    ecdhPrivateKeyIv,
    ecdhPrivateKeyAuthTag,
    attachmentCekRewraps,
    legacyAttachmentsMigratedThisCycle,
  } = payload;

  // ── Defensive guard A: no mode-0 residual ───────────────────────────────
  const mode0Residual = await tx.attachment.count({
    where: { passwordEntry: { userId }, encryptionMode: 0 },
  });
  if (mode0Residual > 0) {
    throw new LegacyAttachmentsResidualError();
  }

  // ── Defensive guard B: manifest subset check ─────────────────────────────
  // Every id in attachmentCekRewraps must exist as a mode-2 row for this user.
  // Extra mode-2 rows in the DB (not in manifest) are allowed — concurrent-
  // upload tolerance.
  const mode2Rows = await tx.attachment.findMany({
    where: { passwordEntry: { userId }, encryptionMode: 2 },
    select: { id: true, cekKeyVersion: true },
  });
  const mode2IdSet = new Set(mode2Rows.map((r) => r.id));
  const mode2KeyVersionMap = new Map(mode2Rows.map((r) => [r.id, r.cekKeyVersion]));

  for (const rewrap of attachmentCekRewraps) {
    if (!mode2IdSet.has(rewrap.id)) {
      throw new AttachmentCekManifestMismatchError();
    }
  }

  // ── Per-row consistency check ────────────────────────────────────────────
  // Read each manifest row's cekKeyVersion BEFORE the User row update
  // (users.keyVersion is still oldKeyVersion inside this tx).
  for (const rewrap of attachmentCekRewraps) {
    const currentCekKeyVersion = mode2KeyVersionMap.get(rewrap.id);
    if (currentCekKeyVersion !== oldKeyVersion) {
      throw new LegacyAttachmentInconsistentVersionError();
    }
  }

  // ── Entry count verification ────────────────────────────────────────────
  const allEntries = await tx.passwordEntry.findMany({
    where: { userId },
    select: { id: true },
  });
  if (entries.length !== allEntries.length) {
    throw new Error("ENTRY_COUNT_MISMATCH");
  }
  const allEntryIdSet = new Set(allEntries.map((e) => e.id));
  const submittedEntryIdSet = new Set(entries.map((e) => e.id));
  if (
    submittedEntryIdSet.size !== entries.length ||
    submittedEntryIdSet.size !== allEntryIdSet.size
  ) {
    throw new Error("ENTRY_COUNT_MISMATCH");
  }
  for (const entryId of submittedEntryIdSet) {
    if (!allEntryIdSet.has(entryId)) {
      throw new Error("ENTRY_COUNT_MISMATCH");
    }
  }

  // ── History count verification ──────────────────────────────────────────
  const allHistory = await tx.passwordEntryHistory.findMany({
    where: { entry: { userId } },
    select: { id: true },
  });
  if (historyEntries.length !== allHistory.length) {
    throw new Error("HISTORY_COUNT_MISMATCH");
  }
  const allHistoryIdSet = new Set(allHistory.map((h) => h.id));
  const submittedHistoryIdSet = new Set(historyEntries.map((h) => h.id));
  if (
    submittedHistoryIdSet.size !== historyEntries.length ||
    submittedHistoryIdSet.size !== allHistoryIdSet.size
  ) {
    throw new Error("HISTORY_COUNT_MISMATCH");
  }
  for (const historyId of submittedHistoryIdSet) {
    if (!allHistoryIdSet.has(historyId)) {
      throw new Error("HISTORY_COUNT_MISMATCH");
    }
  }

  // ── Re-encrypt entries ──────────────────────────────────────────────────
  const ENTRY_BATCH_SIZE = 100;
  for (let i = 0; i < entries.length; i += ENTRY_BATCH_SIZE) {
    const batch = entries.slice(i, i + ENTRY_BATCH_SIZE);
    await Promise.all(batch.map(async (entry) => {
      const updateResult = await tx.passwordEntry.updateMany({
        where: { id: entry.id, userId },
        data: {
          ...toBlobColumns(entry.encryptedBlob),
          ...toOverviewColumns(entry.encryptedOverview),
          aadVersion: entry.aadVersion,
          keyVersion: newKeyVersion,
        },
      });
      if (updateResult.count !== 1) {
        throw new Error("ENTRY_COUNT_MISMATCH");
      }
    }));
  }

  // ── Re-encrypt history blobs ────────────────────────────────────────────
  const HISTORY_BATCH_SIZE = 100;
  for (let i = 0; i < historyEntries.length; i += HISTORY_BATCH_SIZE) {
    const batch = historyEntries.slice(i, i + HISTORY_BATCH_SIZE);
    await Promise.all(batch.map(async (historyEntry) => {
      const updateResult = await tx.passwordEntryHistory.updateMany({
        where: { id: historyEntry.id, entry: { userId } },
        data: {
          ...toBlobColumns(historyEntry.encryptedBlob),
          aadVersion: historyEntry.aadVersion,
          keyVersion: newKeyVersion,
        },
      });
      if (updateResult.count !== 1) {
        throw new Error("HISTORY_COUNT_MISMATCH");
      }
    }));
  }

  // ── Per-row CEK rewrap ──────────────────────────────────────────────────
  // Use updateMany with full ownership scope — never use single-row `update`.
  const cekRewrapsAttempted = attachmentCekRewraps.length;
  let cekRewrapsSucceeded = 0;
  let cekRewrapsFailed = 0;

  for (const rewrap of attachmentCekRewraps) {
    const updateResult = await tx.attachment.updateMany({
      where: {
        id: rewrap.id,
        passwordEntry: { userId, tenantId },
        encryptionMode: 2,
      },
      data: {
        cekEncrypted: Buffer.from(rewrap.cekEncrypted, "base64"),
        cekIv: rewrap.cekIv,
        cekAuthTag: rewrap.cekAuthTag,
        cekKeyVersion: newKeyVersion,
        cekWrapAadVersion: rewrap.cekWrapAadVersion,
      },
    });
    if (updateResult.count !== 1) {
      cekRewrapsFailed += 1;
      throw new AttachmentCekManifestMismatchError();
    }
    cekRewrapsSucceeded += 1;
  }

  // ── Update user vault wrapping (bumps keyVersion) ───────────────────────
  const recoveryWasSet = await tx.user.findUnique({
    where: { id: userId },
    select: { recoveryEncryptedSecretKey: true },
  });
  const recoveryKeyInvalidated = !!recoveryWasSet?.recoveryEncryptedSecretKey;

  await tx.user.update({
    where: { id: userId },
    data: {
      encryptedSecretKey: payload.encryptedSecretKey,
      secretKeyIv: payload.secretKeyIv,
      secretKeyAuthTag: payload.secretKeyAuthTag,
      accountSalt: payload.accountSalt,
      masterPasswordServerHash: newServerHash,
      masterPasswordServerSalt: newServerSalt,
      keyVersion: newKeyVersion,
      ...(payload.newVerifierHash
        ? {
            passphraseVerifierHmac: hmacVerifier(payload.newVerifierHash),
            passphraseVerifierVersion: VERIFIER_VERSION,
          }
        : {}),
      encryptedEcdhPrivateKey,
      ecdhPrivateKeyIv,
      ecdhPrivateKeyAuthTag,
      // Clear recovery wrapping (over old secretKey)
      recoveryEncryptedSecretKey: null,
      recoverySecretKeyIv: null,
      recoverySecretKeyAuthTag: null,
      recoveryHkdfSalt: null,
      recoveryVerifierHmac: null,
      recoveryVerifierVersion: 1,
      recoveryKeySetAt: null,
      recoveryKeyInvalidatedAt: new Date(),
    },
  });

  await tx.vaultKey.create({
    data: {
      userId,
      tenantId,
      version: newKeyVersion,
      verificationCiphertext: payload.verificationArtifact.ciphertext,
      verificationIv: payload.verificationArtifact.iv,
      verificationAuthTag: payload.verificationArtifact.authTag,
    },
  });

  // ── Clear PRF wrapping ─────────────────────────────────────────────────
  const prfClearResult = await tx.webAuthnCredential.updateMany({
    where: { userId, prfEncryptedSecretKey: { not: null } },
    data: {
      prfEncryptedSecretKey: null,
      prfSecretKeyIv: null,
      prfSecretKeyAuthTag: null,
    },
  });

  // ── Mark EA grants STALE ────────────────────────────────────────────────
  const emergencyGrantsCleared = await markGrantsStaleForOwner(userId, newKeyVersion, tx);

  // ── Post-write defensive check ──────────────────────────────────────────
  const staleMode2Count = await tx.attachment.count({
    where: {
      passwordEntry: { userId },
      encryptionMode: 2,
      cekKeyVersion: { not: newKeyVersion },
    },
  });
  if (staleMode2Count > 0) {
    throw new RotationPostConditionError();
  }

  // ── Build audit metadata ────────────────────────────────────────────────
  const cekRewrappedAttachmentIds = attachmentCekRewraps
    .slice(0, ATTACHMENT_MANIFEST_CAP)
    .map((r) => r.id);
  const cekRewrappedAttachmentIdsOverflow = attachmentCekRewraps.length > ATTACHMENT_MANIFEST_CAP;

  return {
    recoveryKeyInvalidated,
    emergencyGrantsCleared,
    prfCredentialsCleared: prfClearResult.count,
    cekRewrapsAttempted,
    cekRewrapsSucceeded,
    cekRewrapsFailed,
    legacyAttachmentsMigratedClientReported: legacyAttachmentsMigratedThisCycle ?? 0,
    mode0Residual: 0,
    cekRewrappedAttachmentIds,
    cekRewrappedAttachmentIdsOverflow,
  };
}

// ── applyAttachmentMigration ─────────────────────────────────────────────────

export interface AttachmentMigrationPayload {
  oldEncryptedDataHash: string; // hex SHA-256 (lowercase) of stored bytes
  encryptedData: string;        // base64 — replacement body under CEK
  iv: string;                   // hex(24)
  authTag: string;              // hex(32)
  cekEncrypted: string;         // base64
  cekIv: string;                // hex(24)
  cekAuthTag: string;           // hex(32)
  cekKeyVersion: number;
  cekWrapAadVersion: number;
}

export interface AttachmentMigrationOptions {
  userId: string;
  tenantId: string;
  entryId: string;
  attachmentId: string;
  payload: AttachmentMigrationPayload;
}

/** Error thrown when migration is attempted on a non-mode-0 attachment. */
export class LegacyMigrationNotApplicableError extends Error {
  constructor() {
    super("LEGACY_MIGRATION_NOT_APPLICABLE");
    this.name = "LegacyMigrationNotApplicableError";
  }
}

/** Error thrown when the supplied hash does not match the stored body. */
export class LegacyBodyHashMismatchError extends Error {
  constructor() {
    super("LEGACY_BODY_HASH_MISMATCH");
    this.name = "LegacyBodyHashMismatchError";
  }
}

/**
 * Migrate a single mode-0 attachment to mode-2 (CEK indirection).
 *
 * Caller is responsible for:
 *   - session auth (no Bearer/SA/MCP)
 *   - rate-limiting
 *   - advisory lock + transaction wrapping
 *   - user keyVersion check (cekKeyVersion must equal user.keyVersion)
 *   - mapping error classes to HTTP responses
 *
 * @param tx   - Prisma interactive transaction client (with RLS set)
 * @param opts - Migration parameters
 */
export async function applyAttachmentMigration(
  tx: Prisma.TransactionClient,
  opts: AttachmentMigrationOptions,
): Promise<{ encryptionMode: 2; fromKeyVersion: number | null }> {
  const { createHash } = await import("node:crypto");
  const { userId, tenantId, entryId, attachmentId, payload } = opts;

  // Scope query: personal entry only, not team entry
  const row = await tx.attachment.findFirst({
    where: {
      id: attachmentId,
      passwordEntry: { userId, tenantId },
      passwordEntryId: { not: null },
      teamPasswordEntryId: null,
    },
    select: { id: true, encryptionMode: true, encryptedData: true, keyVersion: true },
  });
  if (!row) {
    throw new Error("NOT_FOUND");
  }

  // Mode check (I5.3): only mode-0 rows are eligible
  if (row.encryptionMode !== 0) {
    throw new LegacyMigrationNotApplicableError();
  }

  // Body hash check (I5.4)
  const actualHash = createHash("sha256").update(row.encryptedData as Buffer).digest("hex");
  if (actualHash !== payload.oldEncryptedDataHash) {
    throw new LegacyBodyHashMismatchError();
  }

  // Update with updateMany to safely include all scoping predicates (I5.8)
  const updateResult = await tx.attachment.updateMany({
    where: {
      id: attachmentId,
      passwordEntry: { userId, tenantId },
      encryptionMode: 0,
      passwordEntryId: { not: null },
      teamPasswordEntryId: null,
    },
    data: {
      encryptedData: Buffer.from(payload.encryptedData, "base64"),
      iv: payload.iv,
      authTag: payload.authTag,
      cekEncrypted: Buffer.from(payload.cekEncrypted, "base64"),
      cekIv: payload.cekIv,
      cekAuthTag: payload.cekAuthTag,
      cekKeyVersion: payload.cekKeyVersion,
      cekWrapAadVersion: payload.cekWrapAadVersion,
      encryptionMode: 2,
    },
  });
  if (updateResult.count !== 1) {
    throw new Error("NOT_FOUND");
  }

  void entryId; // referenced in audit by caller
  return { encryptionMode: 2 as const, fromKeyVersion: row.keyVersion };
}
