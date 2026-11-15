/**
 * AuditAnchorPublisher against MinIO: a manifest key holds one version
 * whatever is lost or retried — a lost commit, an aborted upload, a competing
 * writer, a second instance, a secondary that is down — and the next manifest
 * chains to that version.
 *
 * MinIO is required: set ANCHOR_TEST_S3_ENDPOINT (e.g. http://127.0.0.1:9000)
 * to a MinIO with the root credentials minioadmin/minioadmin and a KMS key.
 * A missing or unready endpoint fails the suite; it never skips. Every case
 * writes under a prefix of its own in an Object Lock bucket — the objects are
 * locked under COMPLIANCE, so they cannot be deleted and are not.
 *
 * Runs as passwd_anchor_publisher; isolation as in
 * audit-anchor-publisher.integration.test.ts (anchor-publisher-fixtures.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createTestContext, createPrismaForRole, type PrismaWithPool, type TestContext } from "./helpers";
import {
  LEGACY_SETTING,
  advanceChain,
  anchorState,
  createPublisherCase,
  restorePublisherSettings,
  setLastPublishedAt,
  snapshotPublisherSettings,
  wallClockAt,
  writeSetting,
  type PublisherCase,
  type SettingsSnapshot,
} from "./anchor-publisher-fixtures";
import { AuditAnchorPublisher, type CadenceOutcome, type PublisherConfig } from "@/workers/audit-anchor-publisher";
import { publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { chainLocationFor, verify } from "@/lib/audit/anchor-manifest";
import {
  S3Destination,
  joinS3Key,
  type S3DestinationClientOptions,
} from "@/lib/audit/anchor-destinations/s3-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import {
  archivePublicKey,
  createCalls,
  signedManifest,
  storeArtifact,
  trackDestination,
} from "@/__tests__/helpers/anchor-manifest-fixtures";

const ENDPOINT_ENV = "ANCHOR_TEST_S3_ENDPOINT";
const BUCKET = "anchor-test-publisher";

let clientOptions: S3DestinationClientOptions;
let admin: S3Client;

/** sha256 of the manifest a JWS carries — what `previousManifest.sha256` names. */
function manifestSha256(jws: string): string {
  const payload = jws.split(".")[1] ?? "";
  return createHash("sha256").update(Buffer.from(payload, "base64url")).digest("hex");
}

function previousManifestOf(jws: string): { uri: string; sha256: string } | null {
  const payload = jws.split(".")[1] ?? "";
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
    previousManifest: { uri: string; sha256: string } | null;
  }).previousManifest;
}

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

describe("AuditAnchorPublisher — MinIO: one version per manifest key", () => {
  let ctx: TestContext;
  let pub: PrismaWithPool;
  let snapshot: SettingsSnapshot;
  let c: PublisherCase;
  let tenantA: string;
  let tenantB: string;
  let prefix: string;
  let s3: S3Destination;

  function publisher(config: PublisherConfig, client: PrismaWithPool = pub): AuditAnchorPublisher {
    return new AuditAnchorPublisher({ prisma: client.prisma, config });
  }

  function runAt(boundary: Date, destinations: AnchorDestination[], overrides: Partial<PublisherConfig> = {}): Promise<CadenceOutcome> {
    return publisher(c.config(destinations, { now: wallClockAt(boundary), ...overrides })).runCadence(boundary);
  }

  /** The object key of the case's manifest for `boundary`, as S3 stores it. */
  function objectKey(boundary: Date = c.boundary): string {
    return joinS3Key(prefix, c.manifestKey(boundary));
  }

  async function sortedKeys(dest: AnchorDestination): Promise<string[]> {
    return [...(await dest.list())].sort();
  }

  /** A manifest the case's identity would have published to the case's prefix for `boundary`. */
  function ours(boundary: Date, overrides: Partial<Parameters<typeof signedManifest>[0]> = {}) {
    return signedManifest({
      signingKey: c.signingKey,
      boundary,
      deploymentId: c.deploymentId,
      tagSecret: c.tagSecret,
      location: s3.location,
      tenants: [tenantA, tenantB].sort().map((tenantId) => ({
        tenantId,
        chainSeq: 77n,
        prevHash: randomBytes(32),
        epoch: 1,
      })),
      ...overrides,
    });
  }

  /** The case's primary whose create first lets a competing writer store `competing` at the same key. */
  function contended(competing: Buffer) {
    return trackDestination(s3, {
      create: async (args) => {
        await storeArtifact(s3, args.artifactKey, competing);
        return s3.create(args);
      },
    });
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
    pub = createPrismaForRole("anchor-publisher");
    snapshot = await snapshotPublisherSettings(ctx.su);
  });

  afterAll(async () => {
    await restorePublisherSettings(ctx.su, snapshot);
    await pub.prisma.$disconnect();
    await pub.pool.end();
    await ctx.cleanup();
    admin.destroy();
  });

  beforeEach(async () => {
    c = await createPublisherCase(ctx);
    tenantA = await c.createTenant();
    tenantB = await c.createTenant();
    // Nothing under it can be deleted, so a case never shares one.
    prefix = `publisher-it-${randomUUID()}`;
    s3 = new S3Destination({ bucket: BUCKET, prefix, clientOptions });
    await archivePublicKey(s3, c.publicKey);
  });

  afterEach(async () => {
    await c.cleanup();
  });

  it("lost commit: the retry adopts the stored object — one version, the first run's bytes though the chain advanced — and the next manifest chains to it", async () => {
    const lost = await runAt(c.boundary, [s3], {
      hooks: { afterUpload: async () => { throw new Error("commit lost"); } },
    });
    expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.publish_paused_until)).toEqual([null, null]);
    const stored = await versionsOf(objectKey());
    expect(stored).toHaveLength(1);

    await advanceChain(ctx.su, tenantA);
    const retry = await runAt(c.boundary, [s3]);
    expect(retry).toMatchObject({ kind: "published", adopted: true, manifestSha256: manifestSha256(stored[0]!.body) });
    expect(await versionsOf(objectKey())).toEqual(stored);

    const next = c.boundaryAt(1);
    expect(await runAt(next, [s3])).toMatchObject({ kind: "published", adopted: false });
    const nextVersions = await versionsOf(objectKey(next));
    expect(nextVersions).toHaveLength(1);
    expect(previousManifestOf(nextVersions[0]!.body)).toEqual({
      uri: `s3-object-lock://${c.manifestKey()}`,
      sha256: manifestSha256(stored[0]!.body),
    });
    expect(await sortedKeys(s3)).toEqual([c.manifestKey(), c.manifestKey(next), publicKeyArtifactKey(c.kid)].sort());
  });

  it("aborted upload after the object was stored: a pause is written, and the retry adopts the one version and clears it", async () => {
    // The PUT completes; the destination then hangs until the run's bound
    // aborts it — the object is stored, the run sees an upload failure.
    const storedThenHung = trackDestination(s3, {
      create: async (args) => {
        await s3.create({ ...args, signal: undefined });
        return new Promise<never>(() => {});
      },
    });

    const aborted = await runAt(c.boundary, [storedThenHung.dest], { uploadTimeoutMs: 2_000 });
    expect(aborted).toMatchObject({ kind: "failed", stage: "upload", reason: "s3-object-lock_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
    const paused = await anchorState(ctx.su, [tenantA, tenantB]);
    expect(paused.every((s) => s.publish_paused_until !== null)).toBe(true);
    // The failure row only: the missing-prior row goes out with a publish.
    expect((await c.outboxRows()).map((r) => r.failureReason)).toEqual(["s3-object-lock_UPLOAD_FAILED:UPLOAD_TIMEOUT"]);
    const stored = await versionsOf(objectKey());
    expect(stored).toHaveLength(1);

    await advanceChain(ctx.su, tenantA);
    const retry = await runAt(c.boundary, [s3]);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
    expect(await versionsOf(objectKey())).toEqual(stored);
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.publish_paused_until)).toEqual([null, null]);
  });

  it("create conflict, an object this identity signed: adopted, the planted bytes kept, one version", async () => {
    const planted = ours(c.boundary);
    const primary = contended(planted.bytes);

    const outcome = await runAt(c.boundary, [primary.dest]);

    // Create-only: the run's own bytes never became a second version.
    const versions = await versionsOf(objectKey());
    expect(versions.map((v) => v.body)).toEqual([planted.bytes.toString("utf-8")]);
    expect(outcome).toMatchObject({ kind: "published", adopted: true, manifestSha256: planted.sha256 });
    expect((await anchorState(ctx.su, [tenantA, tenantB])).every((s) => s.last_published_at !== null)).toBe(true);
  });

  it("create conflict, garbage: fails closed with the garbage as the one version and nothing recorded", async () => {
    const primary = contended(Buffer.from("garbage"));

    const outcome = await runAt(c.boundary, [primary.dest]);

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE",
      stage: "before_upload",
    });
    expect((await versionsOf(objectKey())).map((v) => v.body)).toEqual(["garbage"]);
    const state = await anchorState(ctx.su, [tenantA, tenantB]);
    expect(state.map((s) => [s.last_published_at, s.publish_paused_until])).toEqual([[null, null], [null, null]]);
  });

  it("create conflict, the own key's object for another deployment id: ends as a skip (row g) with one version", async () => {
    const planted = ours(c.boundary, { deploymentId: "another-deployment" });
    const primary = contended(planted.bytes);

    const outcome = await runAt(c.boundary, [primary.dest]);

    expect(outcome.kind).toBe("skipped_already_published");
    expect((await versionsOf(objectKey())).map((v) => v.body)).toEqual([planted.bytes.toString("utf-8")]);
    expect((await c.outboxRows()).map((r) => r.failureReason)).toEqual(["PUBLISHED_BY_OTHER_IDENTITY"]);
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.last_published_at)).toEqual([null, null]);
  });

  it("two instances, one boundary: the second waits in pg_locks behind the first mid-create, then makes no create and leaves one version", async () => {
    const second = createPrismaForRole("anchor-publisher");
    // Released in `finally` too: a failed assertion must not leave run A
    // holding the lock and its transaction open past the test.
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const runs: Promise<unknown>[] = [];
    try {
      let pidA: number | null = null;
      let enteredCreate: () => void = () => {};
      const creating = new Promise<void>((resolve) => {
        enteredCreate = resolve;
      });
      const blocking = trackDestination(s3, {
        create: async (args) => {
          const result = await s3.create(args);
          enteredCreate();
          await gate;
          return result;
        },
      });
      const waiting = trackDestination(s3);

      const configA = c.config([blocking.dest], {
        hooks: {
          inTx: async (tx) => {
            const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pidA = row?.pid ?? null;
          },
        },
      });
      const configB = c.config([waiting.dest], { lockTimeoutMs: 20_000 });

      const runA = publisher(configA).runCadence(c.boundary);
      runs.push(runA);
      await Promise.race([
        creating,
        runA.then((o) => {
          throw new Error("run A ended first: " + JSON.stringify(o));
        }),
      ]);
      expect(pidA).not.toBeNull();
      const runB = publisher(configB, second).runCadence(c.boundary);
      runs.push(runB);

      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const rows = await ctx.su.prisma.$queryRawUnsafe<{ pid: number }[]>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND $1::int = ANY(pg_blocking_pids(pid))`,
          pidA,
        );
        blocked = rows.length > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);

      releaseA();
      const outcomes = await Promise.all([runA, runB]);
      expect(outcomes.map((o) => (o as CadenceOutcome).kind)).toEqual(["published", "skipped_already_published"]);
      // The lock keeps the second instance from the create at all.
      expect([...createCalls(blocking.calls), ...createCalls(waiting.calls)]).toEqual([`create:${c.manifestKey()}`]);
      expect(await versionsOf(objectKey())).toHaveLength(1);
    } finally {
      releaseA();
      await Promise.allSettled(runs);
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  /**
   * What the unconditional PUT of an earlier release left after a lost commit
   * and its retry: two versions of one key, the later one current, in the
   * format that release wrote (version 1), with its two settings rows.
   */
  async function putTwiceByEarlierRelease() {
    const firstPut = ours(c.boundary, { version: 1 });
    const secondPut = ours(c.boundary, { version: 1 });
    for (const put of [firstPut, secondPut]) {
      await admin.send(new PutObjectCommand({ Bucket: BUCKET, Key: objectKey(), Body: put.bytes }));
    }
    await writeSetting(ctx.su, LEGACY_SETTING.LAST_PUBLISHED_BOUNDARY, c.boundary.toISOString());
    await writeSetting(
      ctx.su,
      LEGACY_SETTING.PREVIOUS_MANIFEST,
      JSON.stringify({ uri: `s3-object-lock://${c.manifestKey()}`, sha256: firstPut.sha256 }),
    );
    const before = await versionsOf(objectKey());
    expect(before.filter((v) => v.isLatest).map((v) => v.body)).toEqual([secondPut.bytes.toString("utf-8")]);
    expect(before).toHaveLength(2);
    return { secondPut, before };
  }

  it("upgrade: a key an earlier release PUT twice and recorded, with its legacy rows — the same boundary skips without a third version and the next chains to the current one, in version 2", async () => {
    const { secondPut, before } = await putTwiceByEarlierRelease();
    // That release wrote last_published_at with its publish.
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], new Date(wallClockAt(c.boundary)()));

    const same = await runAt(c.boundary, [s3]);
    expect(same.kind).toBe("skipped_already_published");
    expect(await versionsOf(objectKey())).toEqual(before);

    const next = c.boundaryAt(1);
    expect(await runAt(next, [s3])).toMatchObject({ kind: "published", adopted: false });
    const nextVersions = await versionsOf(objectKey(next));
    expect(nextVersions).toHaveLength(1);
    expect(previousManifestOf(nextVersions[0]!.body)?.sha256).toBe(secondPut.sha256);
    expect(verify(nextVersions[0]!.body, c.publicKey)).toMatchObject({
      version: 2,
      chainLocation: chainLocationFor(`s3://${BUCKET}/${prefix}`),
    });
  });

  it("upgrade: the same key where the database lost that release's record fails closed without a third version; the record restored, it skips", async () => {
    const { before } = await putTwiceByEarlierRelease();
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], null);

    const refused = await runAt(c.boundary, [s3]);

    expect(refused).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:LEGACY_MANIFEST_UNSETTLED",
      stage: "before_upload",
    });
    expect(await versionsOf(objectKey())).toEqual(before);
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.last_published_at)).toEqual([null, null]);

    // The runbook's reset: the operator verifies the object and records it.
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], new Date(wallClockAt(c.boundary)()));
    expect((await runAt(c.boundary, [s3])).kind).toBe("skipped_already_published");
    expect(await versionsOf(objectKey())).toEqual(before);
  });

  it("a manifest copied from another prefix of the bucket is refused as the latest and is never adopted; the prefix it was published to accepts it", async () => {
    // An authentic manifest of this identity, published to another prefix.
    const elsewhere = new S3Destination({ bucket: BUCKET, prefix: `publisher-it-${randomUUID()}`, clientOptions });
    await archivePublicKey(elsewhere, c.publicKey);
    expect(await runAt(c.boundary, [elsewhere])).toMatchObject({ kind: "published", adopted: false });
    const copied = (await elsewhere.read(c.manifestKey()))!;
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], null);

    await storeArtifact(s3, c.manifestKey(), copied);
    const before = await sortedKeys(s3);
    const refused = await runAt(c.boundary, [s3]);

    expect(refused).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_FOREIGN_LOCATION",
      stage: "before_upload",
    });
    expect(await sortedKeys(s3)).toEqual(before);
    expect(await versionsOf(objectKey())).toHaveLength(1);
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.last_published_at)).toEqual([null, null]);

    // Allow: the same bytes where they were published are this chain's, and adopted.
    expect(await runAt(c.boundary, [elsewhere])).toMatchObject({ kind: "published", adopted: true });
  });

  it("secondary down for the boundary: the run fails with one version at the primary; back the same day, the retry adopts and mirrors", async () => {
    const { dest: store } = await c.filesystem({ archiveOwnKey: false });
    let down = true;
    const secondary = trackDestination(store, {
      create: async (args) => {
        if (down) throw Object.assign(new Error("unreachable"), { code: "ECONNREFUSED" });
        return store.create(args);
      },
    });
    const primary = trackDestination(s3);

    const failed = await runAt(c.boundary, [primary.dest, secondary.dest]);
    expect(failed).toMatchObject({ kind: "failed", stage: "upload", reason: "filesystem_UPLOAD_FAILED:ECONNREFUSED" });
    const stored = await versionsOf(objectKey());
    expect(stored).toHaveLength(1);
    expect(await store.list()).toEqual([]);
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.last_published_at)).toEqual([null, null]);

    down = false;
    const retry = await runAt(c.boundary, [primary.dest, secondary.dest]);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
    expect(createCalls(primary.calls)).toEqual([`create:${c.manifestKey()}`]);
    expect(await versionsOf(objectKey())).toEqual(stored);
    expect(await store.list()).toEqual([c.manifestKey()]);
    expect((await store.read(c.manifestKey()))?.toString("utf-8")).toBe(stored[0]!.body);
  });
});
