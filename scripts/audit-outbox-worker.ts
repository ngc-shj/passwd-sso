#!/usr/bin/env tsx
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { envObject } from "@/lib/env-schema";
import { createWorker } from "@/workers/audit-outbox-worker";

// Pick only the fields the worker reads. envObject (not envSchema) because
// Zod 4 throws on .pick() of a refined schema (F16).
const workerEnvSchema = envObject.pick({
  DATABASE_URL: true,
  OUTBOX_WORKER_DATABASE_URL: true,
  OUTBOX_BATCH_SIZE: true,
  OUTBOX_POLL_INTERVAL_MS: true,
  OUTBOX_PROCESSING_TIMEOUT_MS: true,
  OUTBOX_MAX_ATTEMPTS: true,
  OUTBOX_RETENTION_HOURS: true,
  OUTBOX_FAILED_RETENTION_DAYS: true,
  OUTBOX_READY_PENDING_THRESHOLD: true,
  OUTBOX_READY_OLDEST_THRESHOLD_SECS: true,
  OUTBOX_REAPER_INTERVAL_MS: true,
  NODE_ENV: true,
  DB_POOL_MAX: true,
  DB_POOL_CONNECTION_TIMEOUT_MS: true,
  DB_POOL_IDLE_TIMEOUT_MS: true,
  DB_POOL_MAX_LIFETIME_SECONDS: true,
  DB_POOL_STATEMENT_TIMEOUT_MS: true,
  LOG_LEVEL: true,
  AUDIT_LOG_FORWARD: true,
  AUDIT_LOG_APP_NAME: true,
});

const parseResult = workerEnvSchema.safeParse(process.env);
if (!parseResult.success) {
  // F30 + S22: never echo rejected value. Emit path + code only.
  for (const issue of parseResult.error.issues) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "env validation failed",
        path: issue.path.join("."),
        code: issue.code,
      }),
    );
  }
  process.exit(1);
}
const workerEnv = parseResult.data;

// T17: --validate-env-only flag exits 0 after parsing, without touching DB.
// Byte-exact contract tested in scripts/__tests__/audit-outbox-worker-env.test.mjs.
if (process.argv.includes("--validate-env-only")) {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

const databaseUrl =
  workerEnv.OUTBOX_WORKER_DATABASE_URL ?? workerEnv.DATABASE_URL;

const worker = createWorker({ databaseUrl });

worker.start().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "Worker fatal error",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
