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
import { assertBypassRlsActive } from "./lib/assert-bypass-rls-active";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { MS_PER_MINUTE } from "@/lib/constants/time";

type RawAccount = {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  refresh_token: string | null;
  access_token: string | null;
  id_token: string | null;
};

const BATCH_SIZE = 500;
// One batch — read + up to BATCH_SIZE encrypt/UPDATE round-trips — runs in a
// single bypass transaction, so the budget is sized by BATCH_SIZE rather than
// left at Prisma's 5s interactive default.
const TX_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  // No DATABASE_URL fallback. That fallback is what made running this against
  // the app credential possible in the first place, and the failure it produced
  // was a silent success. Requiring the migration URL makes the mistake
  // impossible rather than merely detected.
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set MIGRATION_DATABASE_URL to a DDL-capable connection string before running this script.",
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

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
      // `accounts` is FORCE ROW LEVEL SECURITY. Read AND write inside one
      // bypass transaction: outside it the SELECT returns zero rows with no
      // error and this loop would exit reporting a clean, empty success.
      const done = await withBypassRls(
        prisma,
        async (tx) => {
          // The GUC is transaction-scoped, so it is asserted on THIS transaction
          // and before the first read — a probe anywhere else says nothing.
          await assertBypassRlsActive(
            tx,
            "migrate-account-tokens-to-encrypted",
          );

          // The Prisma schema maps Account.providerAccountId to the
          // provider_account_id column (snake_case in DB), so the raw query
          // must reference the column name and alias it back to the camelCase
          // shape the rest of the script reads as.
          // raw-sql-ident: cursorId branch interpolates a fixed literal clause string (never the cursorId value itself, which is bound as $1); BATCH_SIZE is a compile-time constant
          const batch: RawAccount[] = await tx.$queryRawUnsafe<RawAccount[]>(
            `SELECT id, user_id AS "userId", provider,
                provider_account_id AS "providerAccountId",
                refresh_token, access_token, id_token
         FROM accounts
         ${cursorId ? "WHERE id > $1::uuid" : ""}
         ORDER BY id ASC
         LIMIT ${BATCH_SIZE}`,
            ...(cursorId ? [cursorId] : []),
          );
          if (batch.length === 0) return true;

          for (const row of batch) {
            scanned += 1;
            const aad = {
              userId: row.userId,
              provider: row.provider,
              providerAccountId: row.providerAccountId,
            };

            const allNull =
              row.refresh_token == null &&
              row.access_token == null &&
              row.id_token == null;
            if (allNull) {
              skippedNoTokens += 1;
              continue;
            }

            const allEncrypted =
              (row.refresh_token == null ||
                isEncryptedAccountToken(row.refresh_token)) &&
              (row.access_token == null ||
                isEncryptedAccountToken(row.access_token)) &&
              (row.id_token == null || isEncryptedAccountToken(row.id_token));
            if (allEncrypted) {
              skippedAlreadyEncrypted += 1;
              continue;
            }

            const updates: { col: string; value: string }[] = [];
            try {
              if (
                row.refresh_token != null &&
                !isEncryptedAccountToken(row.refresh_token)
              ) {
                updates.push({
                  col: "refresh_token",
                  value: encryptAccountToken(row.refresh_token, aad),
                });
              }
              if (
                row.access_token != null &&
                !isEncryptedAccountToken(row.access_token)
              ) {
                updates.push({
                  col: "access_token",
                  value: encryptAccountToken(row.access_token, aad),
                });
              }
              if (
                row.id_token != null &&
                !isEncryptedAccountToken(row.id_token)
              ) {
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
            const setClauses = updates
              .map((u, i) => `"${u.col}" = $${i + 1}`)
              .join(", ");
            const params = [...updates.map((u) => u.value), row.id];
            try {
              // raw-sql-ident: u.col is drawn only from the closed 3-literal set ("refresh_token"/"access_token"/"id_token") hardcoded above in this function, never from row/user input
              await tx.$executeRawUnsafe(
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
          return false;
        },
        BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
        { timeout: TX_TIMEOUT_MS },
      );
      if (done) break;
      console.log(
        `Progress: scanned=${scanned} rewritten=${rewritten} alreadyEncrypted=${skippedAlreadyEncrypted} noTokens=${skippedNoTokens} failed=${failed}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("Migration complete.");
  console.log(`  scanned             : ${scanned}`);
  console.log(
    `  rewritten           : ${rewritten}${DRY_RUN ? " (dry-run, no writes)" : ""}`,
  );
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
