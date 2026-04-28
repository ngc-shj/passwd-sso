#!/usr/bin/env tsx
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { envObject } from "@/lib/env-schema";
import { createWorker } from "@/workers/dcr-cleanup-worker";

// Pick only the fields the worker reads. envObject (not envSchema) because
// Zod 4 throws on .pick() of a refined schema (F16).
const workerEnvSchema = envObject.pick({
  DATABASE_URL: true,
  DCR_CLEANUP_DATABASE_URL: true,
  DCR_CLEANUP_INTERVAL_MS: true,
  DCR_CLEANUP_BATCH_SIZE: true,
  DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT: true,
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

// --validate-env-only flag exits 0 after parsing, without touching DB.
// Byte-exact contract tested in scripts/__tests__/dcr-cleanup-worker-env.test.mjs.
if (process.argv.includes("--validate-env-only")) {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

const databaseUrl =
  workerEnv.DCR_CLEANUP_DATABASE_URL ?? workerEnv.DATABASE_URL;

const worker = createWorker({
  databaseUrl,
  intervalMs: workerEnv.DCR_CLEANUP_INTERVAL_MS,
  batchSize: workerEnv.DCR_CLEANUP_BATCH_SIZE,
  emitHeartbeatAudit: workerEnv.DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT,
});

// Graceful shutdown: finish in-flight sweep then exit 0.
function handleSignal(signal: string): void {
  console.log(
    JSON.stringify({ level: "info", msg: "dcr-cleanup.shutdown", signal }),
  );
  worker.stop().then(() => {
    process.exit(0);
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "dcr-cleanup.shutdown_error",
        code: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
      }),
    );
    process.exit(1);
  });
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

worker.start().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "dcr-cleanup.fatal",
      code: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
    }),
  );
  process.exit(1);
});
