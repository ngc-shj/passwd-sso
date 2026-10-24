#!/usr/bin/env tsx
import { loadEnv } from "@/lib/load-env";
loadEnv();

import { createPrivateKey } from "node:crypto";

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { auditAnchorPublisherEnvSchema } from "@/lib/env-schema";
import {
  createPublisher,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import { createAnchorScheduler } from "@/workers/audit-anchor-scheduler";
import { S3Destination } from "@/lib/audit/anchor-destinations/s3-destination";
import { GitHubReleaseDestination } from "@/lib/audit/anchor-destinations/github-release-destination";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { derivePublicKey } from "@/lib/audit/anchor-manifest";
import { errorLogFields } from "@/lib/logger/error-fields";
import {
  AUDIT_ANCHOR_CADENCE_MS,
  AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
} from "@/lib/constants/audit/audit";

const parseResult = auditAnchorPublisherEnvSchema.safeParse(process.env);
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
const validateEnvOnly = process.argv.includes("--validate-env-only");

function envValidationPassed(): never {
  console.log(
    JSON.stringify({ level: "info", msg: "env validation passed" }),
  );
  process.exit(0);
}

if (!workerEnv.AUDIT_ANCHOR_PUBLISHER_ENABLED) {
  if (validateEnvOnly) envValidationPassed();
  console.log(
    JSON.stringify({
      level: "info",
      msg: "audit-anchor-publisher.disabled",
      reason: "AUDIT_ANCHOR_PUBLISHER_ENABLED=false",
    }),
  );
  process.exit(0);
}

// The schema requires these whenever the publisher is enabled; narrow the
// types and fail closed if that invariant is ever broken.
const deploymentId = workerEnv.DEPLOYMENT_ID;
const signingKeyHex = workerEnv.AUDIT_ANCHOR_SIGNING_KEY;
const tagSecretHex = workerEnv.AUDIT_ANCHOR_TAG_SECRET;
const databaseUrl = workerEnv.AUDIT_ANCHOR_PUBLISHER_DATABASE_URL ?? workerEnv.DATABASE_URL;
if (!deploymentId || !signingKeyHex || !tagSecretHex || !databaseUrl) {
  console.error(JSON.stringify({ level: "fatal", msg: "env validation failed", code: "custom" }));
  process.exit(1);
}

// Derive signing key kid from PUBLIC key (not private seed) — closes plan S1
// (private-seed prefix would otherwise leak in every published JWS header).
// Process: seed → PKCS#8 PrivateKey → PublicKey → SPKI export → strip 12-byte
// SubjectPublicKeyInfo prefix → 32-byte raw public key → first 8 bytes hex.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX_LEN = 12;
const signingKey = Buffer.from(signingKeyHex, "hex").subarray(0, 32);
const _privateKeyObj = createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_PREFIX, signingKey]),
  format: "der",
  type: "pkcs8",
});
const _publicKeySpki = derivePublicKey(_privateKeyObj).export({
  format: "der",
  type: "spki",
}) as Buffer;
const _publicKeyRaw = _publicKeySpki.subarray(ED25519_SPKI_PREFIX_LEN);
const signingKeyKid = `audit-anchor-${_publicKeyRaw.subarray(0, 8).toString("hex")}`;
const tagSecret = Buffer.from(tagSecretHex, "hex").subarray(0, 32);

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

// Positive boot marker: every destination module loaded and constructed.
console.log(
  JSON.stringify({
    level: "info",
    msg: "destinations ready",
    destinations: destinations.map((d) => d.name),
  }),
);

// --validate-env-only exits 0 here, without touching the database.
if (validateEnvOnly) envValidationPassed();

const publisherConfig: PublisherConfig = {
  databaseUrl,
  deploymentId,
  signingKey,
  signingKeyKid,
  tagSecret,
  destinations,
  cadenceMs: AUDIT_ANCHOR_CADENCE_MS,
  publishOffsetMs: AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
};

const { publisher, shutdown } = createPublisher(publisherConfig);

const scheduler = createAnchorScheduler({
  runCadence: (boundary) => publisher.runCadence(boundary),
  cadenceMs: AUDIT_ANCHOR_CADENCE_MS,
  publishOffsetMs: AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
});

async function boot(): Promise<void> {
  // Boot-time deployment ID check
  await publisher.ensureDeploymentIdMatch();

  console.log(
    JSON.stringify({
      level: "info",
      msg: "audit-anchor-publisher: cadence=24h",
      key: signingKeyKid,
    }),
  );

  // One run for the current boundary, then the schedule stays armed.
  await scheduler.start();
}

let shuttingDown = false;

function handleSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(JSON.stringify({ level: "info", msg: "audit-anchor-publisher.shutdown", signal }));

  // Stop arming and let an in-flight run finish before disconnecting.
  scheduler.stop()
    .then(() => shutdown())
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(
        JSON.stringify({
          level: "fatal",
          msg: "audit-anchor-publisher.shutdown_error",
          error: errorLogFields(err),
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
      // errorLogFields, not a top-level `code` read or the message: a Prisma
      // raw-query failure carries the driver's SQLSTATE nested underneath a
      // P2010, and a message can carry a connection target.
      error: errorLogFields(err),
    }),
  );
  process.exit(1);
});
