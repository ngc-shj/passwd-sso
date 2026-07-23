#!/usr/bin/env tsx
import { z } from "zod";
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { envObject } from "@/lib/env-schema";
import { createWorker } from "@/workers/audit-outbox-worker";
import { validateWebhookDeliveryLease } from "@/lib/constants/audit/webhook-delivery-lease.server";

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
})
  // Least-privilege (2026-07 security review): the worker connects via the
  // dedicated OUTBOX_WORKER_DATABASE_URL and only falls back to DATABASE_URL.
  // DATABASE_URL is therefore optional here so production deployments need not
  // inject the broad app credential alongside the scoped worker role. It stays
  // required in the app path (envObject is untouched). Empty/whitespace is
  // normalized to "unset" so the .refine() below is the single arbiter of the
  // at-least-one-URL rule (path pinned to DATABASE_URL for stable diagnostics).
  .extend({
    DATABASE_URL: z
      .string()
      .transform((s) => s.trim())
      .transform((s) => (s.length === 0 ? undefined : s))
      .optional(),
  })
  // At-least-one-URL (all environments). Path pinned to DATABASE_URL for stable
  // diagnostics on the common "nothing configured" failure.
  .refine(
    (env) => Boolean(env.OUTBOX_WORKER_DATABASE_URL ?? env.DATABASE_URL),
    {
      message:
        "Either OUTBOX_WORKER_DATABASE_URL or DATABASE_URL must be set.",
      path: ["DATABASE_URL"],
    },
  )
  // In production the dedicated scoped-role URL is REQUIRED — the broad app
  // DATABASE_URL must NOT be used as a fallback (least-privilege; 2026-07 review).
  .refine(
    (env) =>
      env.NODE_ENV !== "production" || Boolean(env.OUTBOX_WORKER_DATABASE_URL),
    {
      message:
        "OUTBOX_WORKER_DATABASE_URL is required in production (no DATABASE_URL fallback).",
      path: ["OUTBOX_WORKER_DATABASE_URL"],
    },
  );

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

// Fail-closed lease guard: OUTBOX_PROCESSING_TIMEOUT_MS is Zod-valid down to 10s,
// which is too small to hold one durable-webhook-delivery item's worst case — the
// reaper would reset in-flight rows for a duplicate re-claim. Reject it here so
// --validate-env-only (config-check path) catches it too, not only worker.start().
const leaseError = validateWebhookDeliveryLease(workerEnv.OUTBOX_PROCESSING_TIMEOUT_MS);
if (leaseError) {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "env validation failed",
      path: "OUTBOX_PROCESSING_TIMEOUT_MS",
      code: "webhook_delivery_lease_too_small",
    }),
  );
  process.exit(1);
}

// T17: --validate-env-only flag exits 0 after parsing, without touching DB.
// Byte-exact contract tested in scripts/__tests__/audit-outbox-worker-env.test.mjs.
if (process.argv.includes("--validate-env-only")) {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

// The at-least-one-URL .refine() above guarantees this is non-nullish at
// runtime; narrow the type explicitly and fail closed if that invariant is
// ever broken (defense-in-depth — never connect with an undefined URL).
const databaseUrl =
  workerEnv.OUTBOX_WORKER_DATABASE_URL ?? workerEnv.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "env validation failed",
      path: "DATABASE_URL",
      code: "custom",
    }),
  );
  process.exit(1);
}

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
