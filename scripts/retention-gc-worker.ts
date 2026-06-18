#!/usr/bin/env tsx
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { envObject } from "@/lib/env-schema";
import { createWorker } from "@/workers/retention-gc-worker";

// Pick only the fields the worker reads. envObject (not envSchema) because
// Zod 4 throws on .pick() of a refined schema (F16).
const workerEnvSchema = envObject.pick({
  DATABASE_URL: true,
  RETENTION_GC_DATABASE_URL: true,
  RETENTION_GC_INTERVAL_MS: true,
  RETENTION_GC_BATCH_SIZE: true,
  RETENTION_GC_EMIT_HEARTBEAT_AUDIT: true,
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
// Byte-exact contract tested in scripts/__tests__/retention-gc-worker-env.test.mjs.
if (process.argv.includes("--validate-env-only")) {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

const databaseUrl =
  workerEnv.RETENTION_GC_DATABASE_URL ?? workerEnv.DATABASE_URL;

const worker = createWorker({
  databaseUrl,
  intervalMs: workerEnv.RETENTION_GC_INTERVAL_MS,
  batchSize: workerEnv.RETENTION_GC_BATCH_SIZE,
  emitHeartbeatAudit: workerEnv.RETENTION_GC_EMIT_HEARTBEAT_AUDIT,
});

// Graceful shutdown: finish in-flight sweep then exit 0.
function handleSignal(signal: string): void {
  console.log(
    JSON.stringify({ level: "info", msg: "retention-gc.shutdown", signal }),
  );
  worker.stop().then(() => {
    process.exit(0);
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "retention-gc.shutdown_error",
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
      msg: "retention-gc.fatal",
      code: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
    }),
  );
  process.exit(1);
});
