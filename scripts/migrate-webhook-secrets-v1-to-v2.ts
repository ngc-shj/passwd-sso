/**
 * One-shot migration: webhook secrets v1 (no-AAD) → v2 (AAD-bound).
 *
 * Walks team_webhooks and tenant_webhooks for rows with secretAadVersion=1,
 * decrypts with the legacy no-AAD path, re-encrypts with v2 AAD bound to
 * (tableName | version | webhookId | tenantId | teamId?), and atomically
 * updates ciphertext + iv + authTag + secretAadVersion within a transaction.
 *
 * Idempotent: post-migration runs are no-ops (no v1 rows remain).
 *
 * Usage:
 *   MIGRATION_DATABASE_URL=postgres://passwd_user:... \
 *     npx tsx scripts/migrate-webhook-secrets-v1-to-v2.ts [--dry-run]
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { config } from "dotenv";
import { resolve } from "node:path";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { buildWebhookSecretAAD } from "@/lib/crypto/webhook-aad";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const NEW_AAD_VERSION = 2;

// Load env from .env.local if present (matches prisma.config.ts pattern)
config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

interface WebhookRow {
  id: string;
  tenantId: string;
  teamId: string | null; // null for TenantWebhook
  secretEncrypted: string;
  secretIv: string;
  secretAuthTag: string;
  masterKeyVersion: number;
}

function decryptV1NoAad(row: WebhookRow): string {
  const masterKey = getMasterKeyByVersion(row.masterKeyVersion);
  const iv = Buffer.from(row.secretIv, "hex");
  const authTag = Buffer.from(row.secretAuthTag, "hex");
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(row.secretEncrypted, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function encryptV2WithAad(
  plaintext: string,
  masterKey: Buffer,
  aad: Buffer,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(aad);
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

export interface MigrationStats {
  teamRowsMigrated: number;
  tenantRowsMigrated: number;
  teamRowsSkipped: number;
  tenantRowsSkipped: number;
}

export async function migrateWebhookSecrets(
  prisma: PrismaClient,
  options: { dryRun: boolean },
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    teamRowsMigrated: 0,
    tenantRowsMigrated: 0,
    teamRowsSkipped: 0,
    tenantRowsSkipped: 0,
  };

  // ── TeamWebhook ──────────────────────────────────────────────
  const teamRows = await prisma.teamWebhook.findMany({
    where: { secretAadVersion: 1 },
    select: {
      id: true,
      tenantId: true,
      teamId: true,
      secretEncrypted: true,
      secretIv: true,
      secretAuthTag: true,
      masterKeyVersion: true,
    },
  });

  for (const row of teamRows) {
    try {
      const plaintext = decryptV1NoAad({ ...row, teamId: row.teamId });
      const currentVersion = getCurrentMasterKeyVersion();
      const aad = buildWebhookSecretAAD({
        tableName: "TeamWebhook",
        version: NEW_AAD_VERSION,
        webhookId: row.id,
        tenantId: row.tenantId,
        teamId: row.teamId,
      });
      const newKey = getMasterKeyByVersion(currentVersion);
      const reEncrypted = encryptV2WithAad(plaintext, newKey, aad);

      if (!options.dryRun) {
        await prisma.teamWebhook.update({
          where: { id: row.id },
          data: {
            secretEncrypted: reEncrypted.ciphertext,
            secretIv: reEncrypted.iv,
            secretAuthTag: reEncrypted.authTag,
            masterKeyVersion: currentVersion,
            secretAadVersion: NEW_AAD_VERSION,
          },
        });
      }
      stats.teamRowsMigrated++;
    } catch (err) {
      console.error(`Failed to migrate TeamWebhook ${row.id}:`, err);
      stats.teamRowsSkipped++;
    }
  }

  // ── TenantWebhook ────────────────────────────────────────────
  const tenantRows = await prisma.tenantWebhook.findMany({
    where: { secretAadVersion: 1 },
    select: {
      id: true,
      tenantId: true,
      secretEncrypted: true,
      secretIv: true,
      secretAuthTag: true,
      masterKeyVersion: true,
    },
  });

  for (const row of tenantRows) {
    try {
      const plaintext = decryptV1NoAad({ ...row, teamId: null });
      const currentVersion = getCurrentMasterKeyVersion();
      const aad = buildWebhookSecretAAD({
        tableName: "TenantWebhook",
        version: NEW_AAD_VERSION,
        webhookId: row.id,
        tenantId: row.tenantId,
      });
      const newKey = getMasterKeyByVersion(currentVersion);
      const reEncrypted = encryptV2WithAad(plaintext, newKey, aad);

      if (!options.dryRun) {
        await prisma.tenantWebhook.update({
          where: { id: row.id },
          data: {
            secretEncrypted: reEncrypted.ciphertext,
            secretIv: reEncrypted.iv,
            secretAuthTag: reEncrypted.authTag,
            masterKeyVersion: currentVersion,
            secretAadVersion: NEW_AAD_VERSION,
          },
        });
      }
      stats.tenantRowsMigrated++;
    } catch (err) {
      console.error(`Failed to migrate TenantWebhook ${row.id}:`, err);
      stats.tenantRowsSkipped++;
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("MIGRATION_DATABASE_URL or DATABASE_URL must be set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`webhook secret migration v1 → v2 (dry-run=${dryRun})`);
    const stats = await migrateWebhookSecrets(prisma, { dryRun });
    console.log("Result:", stats);
    if (stats.teamRowsSkipped > 0 || stats.tenantRowsSkipped > 0) {
      console.error("Some rows could not be migrated. Inspect logs above.");
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run only when invoked directly (not when imported by tests)
if (
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-webhook-secrets-v1-to-v2.ts") ||
    process.argv[1].endsWith("migrate-webhook-secrets-v1-to-v2.js"))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
