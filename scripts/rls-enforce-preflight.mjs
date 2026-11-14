#!/usr/bin/env node
/**
 * Deploy-time preflight for the migration that makes RLS bypass enforcing.
 *
 * Runs in the ECS migrate task BEFORE `prisma migrate deploy`. While the flip
 * migration is pending on a non-fresh database, it refuses unless the operator
 * attested (RLS_ENFORCE_ATTESTED) that the production observations the flip
 * depends on were made. It checks that the operator attested, not that the
 * attestation is true. Compose and other launchers do not run it.
 *
 * Env: MIGRATION_DATABASE_URL (required), RLS_ENFORCE_ATTESTED.
 * Exit 0 = may proceed, 1 = refused or could not decide (fail closed).
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

// name must match prisma/migrations
const FLIP_MIGRATION = "20261114000100_rls_bypass_enforce";
const ATTESTATION_ENV = "RLS_ENFORCE_ATTESTED";

/**
 * @param {{ tableExists: boolean, rows: Array<{ migration_name: string, finished_at: unknown, rolled_back_at: unknown }>, attestation: string | undefined }} input
 * @returns {{ ok: boolean, reason: string }}
 */
function decideFlipPreflight({ tableExists, rows, attestation }) {
  if (!tableExists || rows.length === 0) {
    return { ok: true, reason: "fresh database: no applied migrations to protect" };
  }
  const applied = rows.some(
    (r) => r.migration_name === FLIP_MIGRATION && r.finished_at != null && r.rolled_back_at == null,
  );
  if (applied) {
    return { ok: true, reason: `${FLIP_MIGRATION} is already applied` };
  }
  if (attestation === FLIP_MIGRATION) {
    return { ok: true, reason: `${ATTESTATION_ENV} attests the pending ${FLIP_MIGRATION}` };
  }
  return {
    ok: false,
    reason:
      `${FLIP_MIGRATION} is not applied on this database and ${ATTESTATION_ENV} is not set to it. ` +
      `Make the production checks listed in docs/operations/deployment.md, then export ` +
      `${ATTESTATION_ENV}=${FLIP_MIGRATION} and deploy again. No migration was applied.`,
  };
}

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: MIGRATION_DATABASE_URL is required.");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  let decision;
  try {
    await client.connect();
    const { rows: reg } = await client.query(
      "SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists",
    );
    const tableExists = reg[0].exists === true;
    const rows = tableExists
      ? (
          await client.query(
            "SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations",
          )
        ).rows
      : [];
    decision = decideFlipPreflight({
      tableExists,
      rows,
      attestation: process.env[ATTESTATION_ENV],
    });
  } finally {
    await client.end().catch(() => {});
  }

  if (!decision.ok) {
    console.error(`rls-enforce-preflight: REFUSED: ${decision.reason}`);
    process.exit(1);
  }
  console.log(`rls-enforce-preflight: OK (${decision.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    // Message text only: a pg error object can carry connection parameters.
    console.error(`rls-enforce-preflight: ERROR: ${e instanceof Error ? e.message : "unknown error"}`);
    process.exit(1);
  });
}

export { decideFlipPreflight, FLIP_MIGRATION, ATTESTATION_ENV };
