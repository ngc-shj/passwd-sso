/**
 * AuditAnchorPublisher against MinIO: what a lost commit or an aborted upload
 * leaves in a versioned bucket, and that the retry for the same boundary
 * commits the version the chain then points to.
 *
 * MinIO is required: set ANCHOR_TEST_S3_ENDPOINT (e.g. http://127.0.0.1:9000)
 * to a MinIO with the root credentials minioadmin/minioadmin and a KMS key.
 * A missing or unready endpoint fails the suite; it never skips. Each run
 * writes under its own prefix of an Object Lock bucket — the objects are
 * locked under COMPLIANCE, so they cannot be deleted and are not.
 *
 * Runs as passwd_anchor_publisher; isolation as in
 * audit-anchor-publisher.integration.test.ts (anchor-publisher-fixtures.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createTestContext, createPrismaForRole, type PrismaWithPool, type TestContext } from "./helpers";
import {
  CADENCE_MS,
  SETTING,
  advanceChain,
  anchorState,
  assertOnlyChainEnabledTenants,
  clearPublisherSettings,
  farFutureBoundary,
  makePublisherConfig,
  publisherOutboxRows,
  purgePublisherOutboxRows,
  readSetting,
  restorePublisherSettings,
  seedChainTenant,
  snapshotPublisherSettings,
  type SettingsSnapshot,
} from "./anchor-publisher-fixtures";
import { AuditAnchorPublisher, buildManifestArtifactKey, type PublisherConfig } from "@/workers/audit-anchor-publisher";
import {
  S3Destination,
  joinS3Key,
  type S3DestinationClientOptions,
} from "@/lib/audit/anchor-destinations/s3-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";

const ENDPOINT_ENV = "ANCHOR_TEST_S3_ENDPOINT";
const BUCKET = "anchor-test-publisher";

let clientOptions: S3DestinationClientOptions;
let admin: S3Client;

/** sha256 of the manifest a JWS carries — what the pointer's sha256 names. */
function manifestSha256(jws: string): string {
  const payload = jws.split(".")[1] ?? "";
  return createHash("sha256").update(Buffer.from(payload, "base64url")).digest("hex");
}

function previousManifestOf(jws: string): { sha256: string } | null {
  const payload = jws.split(".")[1] ?? "";
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
    previousManifest: { sha256: string } | null;
  }).previousManifest;
}

/** Every version of `key`, oldest first, with its body. */
/**
 * Every stored version of `key`. The latest is the one S3 marks `IsLatest`,
 * not the newest `LastModified`: two PUTs within one second tie on it.
 */
async function versionsOf(key: string): Promise<Array<{ versionId: string; body: string; isLatest: boolean }>> {
  const listed = await admin.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
  const out: Array<{ versionId: string; body: string; isLatest: boolean }> = [];
  for (const v of (listed.Versions ?? []).filter((v) => v.Key === key)) {
    const res = await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, VersionId: v.VersionId }));
    out.push({
      versionId: v.VersionId ?? "",
      body: (await res.Body?.transformToString("utf-8")) ?? "",
      isLatest: v.IsLatest === true,
    });
  }
  return out;
}

/** The latest version's manifest digest and the other versions', of `key`. */
async function latestAndEarlierSha(key: string): Promise<{ latest: string; earlier: string[] }> {
  const versions = await versionsOf(key);
  const latest = versions.filter((v) => v.isLatest);
  expect(latest).toHaveLength(1);
  return {
    latest: manifestSha256(latest[0]?.body ?? ""),
    earlier: versions.filter((v) => !v.isLatest).map((v) => manifestSha256(v.body)),
  };
}

describe("AuditAnchorPublisher — MinIO versions across a lost commit", () => {
  let ctx: TestContext;
  let pub: PrismaWithPool;
  let snapshot: SettingsSnapshot;
  let tenantA: string;
  let tenantB: string;
  let base: Date;
  let caseIndex = 0;
  let prefix: string;
  const usedBoundaries: Date[] = [];

  function nextBoundary(): Date {
    const b = new Date(base.getTime() + caseIndex++ * 10 * CADENCE_MS);
    usedBoundaries.push(b, new Date(b.getTime() + CADENCE_MS));
    return b;
  }

  function publisher(config: PublisherConfig): AuditAnchorPublisher {
    return new AuditAnchorPublisher({ prisma: pub.prisma, config });
  }

  beforeAll(async () => {
    const endpoint = process.env[ENDPOINT_ENV];
    if (!endpoint) {
      throw new Error(
        `${ENDPOINT_ENV} is not set. Start MinIO (with MINIO_KMS_SECRET_KEY) and export ` +
          `${ENDPOINT_ENV}=http://127.0.0.1:9000 to run the publisher's S3 cases.`,
      );
    }
    const ready = await fetch(new URL("/minio/health/ready", endpoint)).then(
      (res) => res.status,
      (error: unknown) => `unreachable (${String(error)})`,
    );
    if (ready !== 200) {
      throw new Error(`MinIO at ${endpoint} is not ready: /minio/health/ready answered ${ready}.`);
    }
    clientOptions = {
      endpoint,
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    };
    admin = new S3Client(clientOptions);
    try {
      await admin.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Object Lock implies versioning, which is what these cases read.
      await admin.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
    }

    ctx = await createTestContext();
    await assertOnlyChainEnabledTenants(ctx.su, []);
    pub = createPrismaForRole("anchor-publisher");
    snapshot = await snapshotPublisherSettings(ctx.su);
    base = farFutureBoundary();
    prefix = `publisher-it-${randomUUID()}`;
  });

  afterAll(async () => {
    await purgePublisherOutboxRows(ctx.su, usedBoundaries);
    await restorePublisherSettings(ctx.su, snapshot);
    await pub.prisma.$disconnect();
    await pub.pool.end();
    await ctx.cleanup();
    admin.destroy();
  });

  beforeEach(async () => {
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    await seedChainTenant(ctx.su, tenantA, { enabled: true });
    await seedChainTenant(ctx.su, tenantB, { enabled: true });
    await assertOnlyChainEnabledTenants(ctx.su, [tenantA, tenantB]);
    await clearPublisherSettings(ctx.su);
  });

  afterEach(async () => {
    await clearPublisherSettings(ctx.su, [SETTING.UPLOAD_ATTEMPTS]);
    await clearPublisherSettings(ctx.su);
    await purgePublisherOutboxRows(ctx.su, usedBoundaries);
    await ctx.deleteTestData(tenantA);
    await ctx.deleteTestData(tenantB);
  });

  async function pointerSha(): Promise<string> {
    const raw = await readSetting(ctx.su, SETTING.PREVIOUS_MANIFEST);
    return (JSON.parse(raw ?? "null") as { sha256: string }).sha256;
  }

  it("lost commit: the retry re-PUTs the key; the latest version is the committed one and the next manifest chains to it", async () => {
    const boundary = nextBoundary();
    const s3 = new S3Destination({ bucket: BUCKET, prefix, clientOptions });
    const config = makePublisherConfig([s3]);
    const key = joinS3Key(prefix, buildManifestArtifactKey(boundary, config.signingKeyKid));

    const lost = await publisher({
      ...config,
      hooks: { afterUpload: async () => { throw new Error("commit lost"); } },
    }).runCadence(boundary);
    expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.publish_paused_until)).toEqual([null, null]);

    await advanceChain(ctx.su, tenantA);
    const retry = await publisher(config).runCadence(boundary);
    expect(retry.kind).toBe("published");

    const { latest, earlier } = await latestAndEarlierSha(key);
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).not.toBe(latest);
    expect(await pointerSha()).toBe(latest);

    const next = new Date(boundary.getTime() + CADENCE_MS);
    expect((await publisher(config).runCadence(next)).kind).toBe("published");
    const nextKey = joinS3Key(prefix, buildManifestArtifactKey(next, config.signingKeyKid));
    const nextVersion = (await versionsOf(nextKey)).find((v) => v.isLatest);
    expect(previousManifestOf(nextVersion?.body ?? "")?.sha256).toBe(latest);
  });

  it("aborted upload after the object was stored: a pause is written, and the retry publishes and clears it", async () => {
    const boundary = nextBoundary();
    const s3 = new S3Destination({ bucket: BUCKET, prefix, clientOptions });
    // The PUT completes; the destination then hangs until the upload bound
    // aborts it — the object is stored, the run sees an upload failure.
    const storedThenHung: AnchorDestination = {
      name: s3.name,
      upload: async (args) => {
        await s3.upload({ ...args, signal: undefined });
        await new Promise<void>(() => {});
      },
    };
    const config = makePublisherConfig([s3]);
    const key = joinS3Key(prefix, buildManifestArtifactKey(boundary, config.signingKeyKid));

    const aborted = await publisher({ ...config, destinations: [storedThenHung], uploadTimeoutMs: 2_000 }).runCadence(boundary);
    expect(aborted).toMatchObject({ kind: "failed", stage: "upload", reason: "s3-object-lock_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
    const paused = await anchorState(ctx.su, [tenantA, tenantB]);
    expect(paused.every((s) => s.publish_paused_until !== null)).toBe(true);
    // The failure row only: the missing-prior row goes out with a publish.
    expect((await publisherOutboxRows(ctx.su, [boundary])).map((r) => r.failureReason)).toEqual([
      "s3-object-lock_UPLOAD_FAILED:UPLOAD_TIMEOUT",
    ]);

    await advanceChain(ctx.su, tenantA);
    const retry = await publisher(config).runCadence(boundary);
    expect(retry.kind).toBe("published");

    const { latest, earlier } = await latestAndEarlierSha(key);
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).not.toBe(latest);
    expect(await pointerSha()).toBe(latest);
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.publish_paused_until)).toEqual([null, null]);
  });
});
