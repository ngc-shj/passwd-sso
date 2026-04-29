#!/usr/bin/env tsx
//
// One-shot data migration: rewrite legacy plaintext OAuth tokens in the
// `accounts` table to the encrypted-at-rest format.
//
// Idempotent — rows whose tokens already start with the `psoenc1:` sentinel
// are skipped. Safe to re-run after a crash. Streams in batches so the
// memory footprint is bounded for large account counts.
//
// Usage:
//   MIGRATION_DATABASE_URL=postgresql://... npm run migrate:account-tokens
//   MIGRATION_DATABASE_URL=postgresql://... npm run migrate:account-tokens -- --dry-run
//
// Run as the DDL/DML role (`passwd_user` / superuser owner), NOT as the
// app role. The app role has RLS enforced and cannot see all accounts;
// this script bypasses tenant isolation by reading from a privileged
// connection. Confirm before running in production.

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  encryptAccountToken,
  isEncryptedAccountToken,
} from "@/lib/crypto/account-token-crypto";

type RawAccount = {
  id: string;
  provider: string;
  providerAccountId: string;
  refresh_token: string | null;
  access_token: string | null;
  id_token: string | null;
};

const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set MIGRATION_DATABASE_URL (or DATABASE_URL) to a privileged connection string before running this script.",
    );
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  let cursorId: string | null = null;
  let scanned = 0;
  let rewritten = 0;
  let skippedAlreadyEncrypted = 0;
  let skippedNoTokens = 0;
  let failed = 0;

  console.log(
    `Starting account token migration. dryRun=${DRY_RUN} batchSize=${BATCH_SIZE}`,
  );

  try {
    while (true) {
      const batch: RawAccount[] = await prisma.$queryRawUnsafe<RawAccount[]>(
        `SELECT id, provider, "providerAccountId", refresh_token, access_token, id_token
         FROM accounts
         ${cursorId ? "WHERE id > $1::uuid" : ""}
         ORDER BY id ASC
         LIMIT ${BATCH_SIZE}`,
        ...(cursorId ? [cursorId] : []),
      );
      if (batch.length === 0) break;

      for (const row of batch) {
        scanned += 1;
        const aad = {
          provider: row.provider,
          providerAccountId: row.providerAccountId,
        };

        const allNull =
          row.refresh_token == null && row.access_token == null && row.id_token == null;
        if (allNull) {
          skippedNoTokens += 1;
          continue;
        }

        const allEncrypted =
          (row.refresh_token == null || isEncryptedAccountToken(row.refresh_token)) &&
          (row.access_token == null || isEncryptedAccountToken(row.access_token)) &&
          (row.id_token == null || isEncryptedAccountToken(row.id_token));
        if (allEncrypted) {
          skippedAlreadyEncrypted += 1;
          continue;
        }

        const updates: { col: string; value: string }[] = [];
        try {
          if (row.refresh_token != null && !isEncryptedAccountToken(row.refresh_token)) {
            updates.push({
              col: "refresh_token",
              value: encryptAccountToken(row.refresh_token, aad),
            });
          }
          if (row.access_token != null && !isEncryptedAccountToken(row.access_token)) {
            updates.push({
              col: "access_token",
              value: encryptAccountToken(row.access_token, aad),
            });
          }
          if (row.id_token != null && !isEncryptedAccountToken(row.id_token)) {
            updates.push({
              col: "id_token",
              value: encryptAccountToken(row.id_token, aad),
            });
          }
        } catch (err) {
          failed += 1;
          console.error(`Encrypt failed for account ${row.id}:`, err);
          continue;
        }

        if (updates.length === 0) {
          skippedAlreadyEncrypted += 1;
          continue;
        }

        if (DRY_RUN) {
          rewritten += 1;
          continue;
        }

        // Single-row UPDATE, parameterized. Build the SET clause from the
        // fields that actually need rewriting.
        const setClauses = updates.map((u, i) => `"${u.col}" = $${i + 1}`).join(", ");
        const params = [...updates.map((u) => u.value), row.id];
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE accounts SET ${setClauses} WHERE id = $${updates.length + 1}::uuid`,
            ...params,
          );
          rewritten += 1;
        } catch (err) {
          failed += 1;
          console.error(`UPDATE failed for account ${row.id}:`, err);
        }
      }

      cursorId = batch[batch.length - 1].id;
      console.log(
        `Progress: scanned=${scanned} rewritten=${rewritten} alreadyEncrypted=${skippedAlreadyEncrypted} noTokens=${skippedNoTokens} failed=${failed}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("Migration complete.");
  console.log(`  scanned             : ${scanned}`);
  console.log(`  rewritten           : ${rewritten}${DRY_RUN ? " (dry-run, no writes)" : ""}`);
  console.log(`  alreadyEncrypted    : ${skippedAlreadyEncrypted}`);
  console.log(`  noTokens            : ${skippedNoTokens}`);
  console.log(`  failed              : ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
