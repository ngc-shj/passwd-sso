#!/usr/bin/env tsx
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { envObject } from "@/lib/env-schema";
import {
  createPublisher,
  currentCadenceBoundary,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import { S3Destination } from "@/lib/audit/anchor-destinations/s3-destination";
import { GitHubReleaseDestination } from "@/lib/audit/anchor-destinations/github-release-destination";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import {
  AUDIT_ANCHOR_CADENCE_MS,
  AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
  AUDIT_ANCHOR_PAUSE_CAP_FACTOR,
} from "@/lib/constants/audit/audit";

// Pick only the fields the worker reads. envObject (not envSchema) because
// Zod 4 throws on .pick() of a refined schema (F16).
const workerEnvSchema = envObject.pick({
  DATABASE_URL: true,
  AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: true,
  DEPLOYMENT_ID: true,
  AUDIT_ANCHOR_SIGNING_KEY: true,
  AUDIT_ANCHOR_TAG_SECRET: true,
  AUDIT_ANCHOR_PUBLISHER_ENABLED: true,
  AUDIT_ANCHOR_DESTINATION_S3_BUCKET: true,
  AUDIT_ANCHOR_DESTINATION_S3_PREFIX: true,
  AUDIT_ANCHOR_DESTINATION_GH_REPO: true,
  AUDIT_ANCHOR_DESTINATION_GH_TOKEN: true,
  AUDIT_ANCHOR_DESTINATION_FS_PATH: true,
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
if (process.argv.includes("--validate-env-only")) {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

if (!workerEnv.AUDIT_ANCHOR_PUBLISHER_ENABLED) {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "audit-anchor-publisher.disabled",
      reason: "AUDIT_ANCHOR_PUBLISHER_ENABLED=false",
    }),
  );
  process.exit(0);
}

// Required fields when publisher is enabled
if (!workerEnv.DEPLOYMENT_ID) {
  console.error(JSON.stringify({ level: "fatal", msg: "DEPLOYMENT_ID is required when publisher is enabled" }));
  process.exit(1);
}
if (!workerEnv.AUDIT_ANCHOR_SIGNING_KEY) {
  console.error(JSON.stringify({ level: "fatal", msg: "AUDIT_ANCHOR_SIGNING_KEY is required when publisher is enabled" }));
  process.exit(1);
}
if (!workerEnv.AUDIT_ANCHOR_TAG_SECRET) {
  console.error(JSON.stringify({ level: "fatal", msg: "AUDIT_ANCHOR_TAG_SECRET is required when publisher is enabled" }));
  process.exit(1);
}

// Derive signing key kid from first 8 chars of hex key
const signingKeyHex = workerEnv.AUDIT_ANCHOR_SIGNING_KEY;
const signingKeyKid = `audit-anchor-${signingKeyHex.slice(0, 8)}`;
const signingKey = Buffer.from(signingKeyHex, "hex").subarray(0, 32);
const tagSecret = Buffer.from(workerEnv.AUDIT_ANCHOR_TAG_SECRET, "hex").subarray(0, 32);

// Build destinations
const destinations: AnchorDestination[] = [];

if (workerEnv.AUDIT_ANCHOR_DESTINATION_S3_BUCKET) {
  destinations.push(
    new S3Destination({
      bucket: workerEnv.AUDIT_ANCHOR_DESTINATION_S3_BUCKET,
      prefix: workerEnv.AUDIT_ANCHOR_DESTINATION_S3_PREFIX ?? "",
    }),
  );
}

if (workerEnv.AUDIT_ANCHOR_DESTINATION_GH_REPO) {
  const ghToken = workerEnv.AUDIT_ANCHOR_DESTINATION_GH_TOKEN ?? process.env["GITHUB_TOKEN"];
  if (!ghToken) {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "GITHUB_TOKEN or AUDIT_ANCHOR_DESTINATION_GH_TOKEN is required for GitHub release destination",
      }),
    );
    process.exit(1);
  }
  destinations.push(
    new GitHubReleaseDestination({
      repo: workerEnv.AUDIT_ANCHOR_DESTINATION_GH_REPO,
      token: ghToken,
    }),
  );
}

if (workerEnv.AUDIT_ANCHOR_DESTINATION_FS_PATH) {
  destinations.push(
    new FilesystemDestination({
      basePath: workerEnv.AUDIT_ANCHOR_DESTINATION_FS_PATH,
    }),
  );
}

if (destinations.length === 0) {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "No destinations configured. Set at least one of: AUDIT_ANCHOR_DESTINATION_S3_BUCKET, AUDIT_ANCHOR_DESTINATION_GH_REPO, AUDIT_ANCHOR_DESTINATION_FS_PATH",
    }),
  );
  process.exit(1);
}

const databaseUrl = workerEnv.AUDIT_ANCHOR_PUBLISHER_DATABASE_URL ?? workerEnv.DATABASE_URL;

const publisherConfig: PublisherConfig = {
  databaseUrl,
  deploymentId: workerEnv.DEPLOYMENT_ID,
  signingKey,
  signingKeyKid,
  tagSecret,
  destinations,
  cadenceMs: AUDIT_ANCHOR_CADENCE_MS,
  publishOffsetMs: AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
  pauseCapFactor: AUDIT_ANCHOR_PAUSE_CAP_FACTOR,
};

const { publisher, shutdown } = createPublisher(publisherConfig);

// Compute next cadence boundary for alignment
const now = new Date();
const nextBoundary = new Date(
  currentCadenceBoundary(now, AUDIT_ANCHOR_CADENCE_MS, AUDIT_ANCHOR_PUBLISH_OFFSET_MS).getTime() +
  AUDIT_ANCHOR_CADENCE_MS,
);

let running = true;
let cadenceTimer: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  try {
    const result = await publisher.runCadence(new Date());
    console.log(JSON.stringify({ level: "info", msg: "audit-anchor-publisher.cadence", result }));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "audit-anchor-publisher.cadence_error",
        code: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
      }),
    );
  }
}

async function boot(): Promise<void> {
  // Boot-time deployment ID check
  await publisher.ensureDeploymentIdMatch();

  console.log(
    JSON.stringify({
      level: "info",
      msg: "audit-anchor-publisher: cadence=24h",
      next_publish: nextBoundary.toISOString(),
      key: signingKeyKid,
    }),
  );

  // Align first run to next cadence boundary
  const msUntilNext = nextBoundary.getTime() - Date.now();
  const alignTimer = setTimeout(async () => {
    if (!running) return;
    await runOnce();

    // After alignment, fire on regular cadence
    cadenceTimer = setInterval(async () => {
      if (!running) return;
      await runOnce();
    }, AUDIT_ANCHOR_CADENCE_MS);
  }, msUntilNext);

  // Ensure alignment timer is also clearable on shutdown
  process.once("_publisher_shutdown_clear_align", () => clearTimeout(alignTimer));
}

function handleSignal(signal: string): void {
  running = false;
  if (cadenceTimer) clearInterval(cadenceTimer);
  process.emit("_publisher_shutdown_clear_align" as never);

  console.log(JSON.stringify({ level: "info", msg: "audit-anchor-publisher.shutdown", signal }));

  shutdown().then(() => {
    process.exit(0);
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "audit-anchor-publisher.shutdown_error",
        code: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
      }),
    );
    process.exit(1);
  });
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

boot().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "audit-anchor-publisher.boot_failed",
      code: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
