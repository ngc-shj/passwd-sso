#!/usr/bin/env tsx
import { z } from "zod";
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { envObject } from "@/lib/env-schema";
import { createWorker } from "@/workers/retention-gc-worker";
import { buildSweepOpts } from "@/workers/retention-gc-worker/options";
import { BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";
import { BLOB_STORAGE, getAttachmentBlobStore, resolveBlobBackend } from "@/lib/blob-store";
import { blobErrorStatus } from "@/lib/blob-store/errors";
import { errorLogFields } from "@/lib/logger/error-fields";

/**
 * An optional variable that is present but empty reads as unset — what the
 * blob store does at run time (src/lib/blob-store/config.ts trims and treats
 * "" as missing), so a `KEY=` line in an env file does not fail the boot.
 */
function emptyAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);
}

// --init-blob-marker writes the bucket marker and exits without connecting to
// the database, so the database-URL rules below do not apply to it.
const initBlobMarkerRun = process.argv.includes("--init-blob-marker");

// Pick only the fields the worker reads. envObject (not envSchema) because
// Zod 4 throws on .pick() of a refined schema (F16).
const workerEnvSchema = envObject.pick({
  DATABASE_URL: true,
  RETENTION_GC_DATABASE_URL: true,
  RETENTION_GC_INTERVAL_MS: true,
  RETENTION_GC_BATCH_SIZE: true,
  RETENTION_GC_EMIT_HEARTBEAT_AUDIT: true,
  RETENTION_GC_TEAM_KEY_PRUNE_ENABLED: true,
  RETENTION_GC_BLOB_SWEEP_MODE: true,
  RETENTION_GC_BLOB_ORPHAN_GRACE_MS: true,
  RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS: true,
  RETENTION_GC_BLOB_SWEEP_MAX_DELETES: true,
  RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO: true,
  DEPLOYMENT_ID: true,
  // The blob store reads these from process.env itself; picking them
  // validates them at boot (the trash purge and the orphan sweep use them).
  BLOB_BACKEND: true,
  BLOB_OBJECT_PREFIX: true,
  AWS_REGION: true,
  S3_ATTACHMENTS_BUCKET: true,
  S3_FORCE_PATH_STYLE: true,
  AZURE_STORAGE_ACCOUNT: true,
  AZURE_BLOB_CONTAINER: true,
  AZURE_STORAGE_CONNECTION_STRING: true,
  AZURE_STORAGE_SAS_TOKEN: true,
  GCS_ATTACHMENTS_BUCKET: true,
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
  // dedicated RETENTION_GC_DATABASE_URL and only falls back to DATABASE_URL.
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
    DEPLOYMENT_ID: emptyAsUnset(envObject.shape.DEPLOYMENT_ID),
    RETENTION_GC_BLOB_ORPHAN_GRACE_MS: emptyAsUnset(envObject.shape.RETENTION_GC_BLOB_ORPHAN_GRACE_MS),
    BLOB_BACKEND: emptyAsUnset(envObject.shape.BLOB_BACKEND),
    AWS_REGION: emptyAsUnset(envObject.shape.AWS_REGION),
    S3_ATTACHMENTS_BUCKET: emptyAsUnset(envObject.shape.S3_ATTACHMENTS_BUCKET),
    S3_FORCE_PATH_STYLE: emptyAsUnset(envObject.shape.S3_FORCE_PATH_STYLE),
    AZURE_STORAGE_ACCOUNT: emptyAsUnset(envObject.shape.AZURE_STORAGE_ACCOUNT),
    AZURE_BLOB_CONTAINER: emptyAsUnset(envObject.shape.AZURE_BLOB_CONTAINER),
    AZURE_STORAGE_CONNECTION_STRING: emptyAsUnset(envObject.shape.AZURE_STORAGE_CONNECTION_STRING),
    AZURE_STORAGE_SAS_TOKEN: emptyAsUnset(envObject.shape.AZURE_STORAGE_SAS_TOKEN),
    GCS_ATTACHMENTS_BUCKET: emptyAsUnset(envObject.shape.GCS_ATTACHMENTS_BUCKET),
  })
  // At-least-one-URL (all environments). Path pinned to DATABASE_URL for stable
  // diagnostics on the common "nothing configured" failure.
  .refine(
    (env) => initBlobMarkerRun || Boolean(env.RETENTION_GC_DATABASE_URL ?? env.DATABASE_URL),
    {
      message:
        "Either RETENTION_GC_DATABASE_URL or DATABASE_URL must be set.",
      path: ["DATABASE_URL"],
    },
  )
  // In production the dedicated scoped-role URL is REQUIRED — the broad app
  // DATABASE_URL must NOT be used as a fallback (least-privilege; 2026-07 review).
  .refine(
    (env) =>
      initBlobMarkerRun || env.NODE_ENV !== "production" || Boolean(env.RETENTION_GC_DATABASE_URL),
    {
      message:
        "RETENTION_GC_DATABASE_URL is required in production (no DATABASE_URL fallback).",
      path: ["RETENTION_GC_DATABASE_URL"],
    },
  )
  // The orphan-blob sweep deletes only in a bucket marked with this
  // deployment's id, so any mode but off needs one.
  .refine(
    (env) => env.RETENTION_GC_BLOB_SWEEP_MODE === BLOB_SWEEP_MODE.OFF || Boolean(env.DEPLOYMENT_ID),
    {
      message: "DEPLOYMENT_ID is required when RETENTION_GC_BLOB_SWEEP_MODE is not off.",
      path: ["DEPLOYMENT_ID"],
    },
  )
  // Deletion is irreversible: the grace period must be chosen (>= the
  // database backup retention window, or a versioned bucket), not defaulted.
  .refine(
    (env) =>
      env.RETENTION_GC_BLOB_SWEEP_MODE !== BLOB_SWEEP_MODE.DELETE ||
      env.RETENTION_GC_BLOB_ORPHAN_GRACE_MS !== undefined,
    {
      message: "RETENTION_GC_BLOB_ORPHAN_GRACE_MS must be set explicitly when RETENTION_GC_BLOB_SWEEP_MODE is delete.",
      path: ["RETENTION_GC_BLOB_ORPHAN_GRACE_MS"],
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

// --validate-env-only flag exits 0 after parsing, without touching DB.
// Byte-exact contract tested in scripts/__tests__/retention-gc-worker-env.test.mjs.
if (process.argv.includes("--validate-env-only")) {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

// --init-blob-marker: the operator creates the orphan sweep's bucket marker
// (body = DEPLOYMENT_ID) with a conditional create, prints `created` or
// `exists`, and exits — no DB connection. It refuses (exit 1, nothing written)
// unless the sweep is configured (mode not off, which also requires
// DEPLOYMENT_ID) on an external backend. Run it only from the deployment that
// owns the bucket. A function rather than top-level await: the bundle is CJS.
function initBlobMarkerRefusal(reason: string, extra: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ level: "error", msg: "init-blob-marker refused", reason, ...extra }));
  process.exit(1);
}

async function initBlobMarker(): Promise<void> {
  if (workerEnv.RETENTION_GC_BLOB_SWEEP_MODE === BLOB_SWEEP_MODE.OFF) initBlobMarkerRefusal("blob_sweep_mode_off");
  const deploymentId = workerEnv.DEPLOYMENT_ID;
  if (!deploymentId) initBlobMarkerRefusal("deployment_id_missing");
  if (resolveBlobBackend() === BLOB_STORAGE.DB) initBlobMarkerRefusal("db_backend");
  // A store error rejects and is reported by the caller's handler.
  const result = await getAttachmentBlobStore().createMarker(deploymentId);
  console.log(JSON.stringify({ level: "info", msg: "init-blob-marker", result }));
}

function startWorker(): void {
  // The at-least-one-URL .refine() above guarantees this is non-nullish at
  // runtime; narrow the type explicitly and fail closed if that invariant is
  // ever broken (defense-in-depth — never connect with an undefined URL).
  const databaseUrl =
    workerEnv.RETENTION_GC_DATABASE_URL ?? workerEnv.DATABASE_URL;
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

  const worker = createWorker({
    databaseUrl,
    batchSize: workerEnv.RETENTION_GC_BATCH_SIZE,
    ...buildSweepOpts(workerEnv),
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
}

if (initBlobMarkerRun) {
  initBlobMarker().then(
    () => process.exit(0),
    (err: unknown) => {
      const httpStatusCode = blobErrorStatus(err);
      initBlobMarkerRefusal("store_error", { error: errorLogFields(err), httpStatusCode });
    },
  );
} else {
  startWorker();
}
