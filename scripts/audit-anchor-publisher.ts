#!/usr/bin/env tsx
import { loadEnv } from "@/lib/load-env";
loadEnv();

// Import from env-schema (side-effect-free) — not @/lib/env, which would run
// parseEnv() on the full schema at module load and fail the worker boot when
// non-worker vars (auth providers, WebAuthn, etc.) are absent.
import { auditAnchorPublisherEnvSchema } from "@/lib/env-schema";
import {
  createPublisher,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import { createAnchorScheduler } from "@/workers/audit-anchor-scheduler";
import { createPublisherLifecycle } from "@/workers/audit-anchor-publisher-lifecycle";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import {
  AnchorDestinationConfigError,
  buildDestinationsFromEnv,
} from "@/lib/audit/anchor-destinations/from-env";
import { kidForPublicKey, publicKeyForSigningKey } from "@/lib/audit/anchor-manifest";
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

const signingKey = Buffer.from(signingKeyHex, "hex").subarray(0, 32);
const tagSecret = Buffer.from(tagSecretHex, "hex").subarray(0, 32);

let destinations: AnchorDestination[];
try {
  destinations = buildDestinationsFromEnv({ ...workerEnv, GITHUB_TOKEN: process.env["GITHUB_TOKEN"] });
} catch (err) {
  if (!(err instanceof AnchorDestinationConfigError)) throw err;
  // A fixed message and the error's token (`code` names what is missing): a
  // caught error's message is never logged.
  console.error(
    JSON.stringify({ level: "fatal", msg: "anchor destination configuration invalid", error: errorLogFields(err) }),
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

const lifecycle = createPublisherLifecycle({
  ensureDeploymentIdMatch: () => publisher.ensureDeploymentIdMatch(),
  scheduler,
  shutdown,
  exit: (code) => process.exit(code),
  log: {
    info: (line) => console.log(JSON.stringify(line)),
    error: (line) => console.error(JSON.stringify(line)),
  },
  bootLine: { level: "info", msg: "audit-anchor-publisher: cadence=24h", key: kidForPublicKey(publicKeyForSigningKey(signingKey)) },
});

process.on("SIGTERM", () => lifecycle.handleSignal("SIGTERM"));
process.on("SIGINT", () => lifecycle.handleSignal("SIGINT"));

void lifecycle.boot();
