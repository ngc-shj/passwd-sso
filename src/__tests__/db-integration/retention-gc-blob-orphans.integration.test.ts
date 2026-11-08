/**
 * #1010 (C4): the orphan-blob sweep against a real S3 (MinIO) bucket and real
 * attachments rows read under the worker role.
 *
 * MinIO is mandatory: set ANCHOR_TEST_S3_ENDPOINT (e.g. http://127.0.0.1:9000;
 * docker compose up -d minio). CI starts one (ci-integration.yml). The cells
 * use a dedicated bucket, never S3_ATTACHMENTS_BUCKET, and a fresh prefix per
 * cell, and delete what they wrote in afterAll.
 *
 * `now` is derived from each object's LISTED LastModified (1 s server
 * granularity, and the container's clock is not this process's), so the
 * grace cells sit exactly 1 ms either side of the boundary.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createTestContext, inRetentionSweepTx, setBypassRlsGucs, type TestContext } from "./helpers";
import { readAttachmentRefs, sweepOnce } from "@/workers/retention-gc-worker/sweep";
import { sweepOrphanBlobs, type BlobCursor, type BlobSweepOptions } from "@/workers/retention-gc-worker/sweep-blob-orphans";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";
import { encodeObjectRef, newBlobGeneration } from "@/lib/blob-store/object-ref";

const ENDPOINT_ENV = "ANCHOR_TEST_S3_ENDPOINT";
const BUCKET = "retention-gc-blob-orphans-test";
const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRACE_MS = 3_600_000;
const RUN = `orphans-${randomUUID()}`;
/** The cells write a few dozen objects; far more rounds than that means the cleanup is not converging. */
const CLEANUP_MAX_ROUNDS = 20;
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe("orphan-blob sweep on MinIO (#1010)", () => {
  // Unset until beforeAll gets that far: afterAll cleans up only what exists,
  // so a missing endpoint reports its own error rather than a secondary one.
  let ctx: TestContext;
  let s3: S3Client;
  let tenantId: string;
  let userId: string;
  let prefix: string;

  beforeAll(async () => {
    const endpoint = process.env[ENDPOINT_ENV];
    if (!endpoint) {
      throw new Error(`${ENDPOINT_ENV} is required (a MinIO, e.g. http://127.0.0.1:9000; docker compose up -d minio)`);
    }
    expect(BUCKET).not.toBe(process.env.S3_ATTACHMENTS_BUCKET);
    s3 = new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }
    ctx = await createTestContext();
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    if (s3) {
      // Bounded: each round deletes a listing page (≤ 1000 keys); a partial
      // DeleteObjects failure throws instead of re-listing the same keys forever.
      for (let round = 0; ; round++) {
        if (round >= CLEANUP_MAX_ROUNDS) {
          throw new Error(`afterAll: objects still under ${BUCKET}/${RUN}/ after ${CLEANUP_MAX_ROUNDS} delete rounds`);
        }
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${RUN}/` }));
        const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key ?? "" }));
        if (keys.length === 0) break;
        const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
        const failed = deleted.Errors?.length ?? 0;
        if (failed > 0) {
          throw new Error(`afterAll: DeleteObjects failed for ${failed} of ${keys.length} objects under ${BUCKET}/${RUN}/`);
        }
      }
    }
    if (ctx) {
      if (tenantId) await ctx.deleteTestData(tenantId);
      await ctx.cleanup();
    }
  });

  beforeEach(() => {
    prefix = `${RUN}/${randomUUID()}`;
    vi.stubEnv("BLOB_BACKEND", "s3");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", BUCKET);
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("AWS_ENDPOINT_URL_S3", process.env[ENDPOINT_ENV] ?? "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "minioadmin");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "minioadmin");
    vi.stubEnv("BLOB_OBJECT_PREFIX", prefix);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A fresh store module, so its cached client reads this cell's env. */
  async function loadStore() {
    vi.resetModules();
    return (await import("@/lib/blob-store/s3-blob-store")).s3BlobStore;
  }

  async function put(key: string): Promise<void> {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from("ciphertext") }));
  }

  /** A personal entry with one attachments row whose ref names its object; returns the key. */
  async function referencedObject(): Promise<string> {
    const entryId = randomUUID();
    const attId = randomUUID();
    const key = `${prefix}/personal/${entryId}/${attId}/${newBlobGeneration()}.bin`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'b', 'iv', 'tag', 'o', 'oiv', 'otag', 1, now(), now())`,
        entryId, userId, tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO attachments (id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag, key_version,
           encryption_mode, tenant_id, password_entry_id, created_by_id, created_at)
         VALUES ($1::uuid, 'a.bin', 'application/octet-stream', 10, $2, 'iv', 'tag', 1, 0, $3::uuid, $4::uuid, $5::uuid, now())`,
        attId, Buffer.from(encodeObjectRef({ key })), tenantId, entryId, userId,
      );
    });
    await put(key);
    return key;
  }

  async function orphanObject(): Promise<string> {
    const key = `${prefix}/personal/${randomUUID()}/${randomUUID()}/${newBlobGeneration()}.bin`;
    await put(key);
    return key;
  }

  async function keysUnderPrefix(): Promise<string[]> {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/` }));
    return (listed.Contents ?? []).map((o) => o.Key ?? "").sort();
  }

  async function newestLastModified(): Promise<number> {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/` }));
    return Math.max(...(listed.Contents ?? []).map((o) => o.LastModified?.getTime() ?? 0));
  }

  /** The production row read, under the worker role and the production grant. */
  const readRefs = (ids: string[]) =>
    inRetentionSweepTx(ctx.retentionWorker.prisma, (tx) => readAttachmentRefs(tx, ids), BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP);

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  function opts(overrides: Partial<BlobSweepOptions> = {}): BlobSweepOptions {
    return {
      mode: BLOB_SWEEP_MODE.DELETE,
      graceMs: GRACE_MS,
      maxObjects: 1000,
      maxDeletes: 1000,
      pageSize: 1000,
      maxDeleteRatio: 1,
      deploymentId: DEPLOYMENT_ID,
      ...overrides,
    };
  }

  describe("the marker", () => {
    it("createMarker is a real conditional create: a second create with another body is `exists` and keeps the first", async () => {
      const store = await loadStore();
      await expect(store.readMarker()).resolves.toBeNull();
      await expect(store.createMarker(DEPLOYMENT_ID)).resolves.toBe("created");
      await expect(store.createMarker("11111111-1111-4111-8111-111111111111")).resolves.toBe("exists");
      await expect(store.readMarker()).resolves.toBe(DEPLOYMENT_ID);
      expect(await keysUnderPrefix()).toEqual([`${prefix}/.passwd-sso-deployment`]);
    });

    it("--init-blob-marker on the worker entrypoint prints created, then exists, leaving the body unchanged", () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
        RETENTION_GC_BLOB_SWEEP_MODE: "report",
        BLOB_BACKEND: "s3",
        AWS_REGION: "us-east-1",
        S3_ATTACHMENTS_BUCKET: BUCKET,
        S3_FORCE_PATH_STYLE: "true",
        AWS_ENDPOINT_URL_S3: process.env[ENDPOINT_ENV] ?? "",
        AWS_ACCESS_KEY_ID: "minioadmin",
        AWS_SECRET_ACCESS_KEY: "minioadmin",
        BLOB_OBJECT_PREFIX: prefix,
      };
      const run = (deploymentId: string) =>
        spawnSync("node_modules/.bin/tsx", [resolve(REPO_ROOT, "scripts/retention-gc-worker.ts"), "--init-blob-marker"], {
          env: { ...env, DEPLOYMENT_ID: deploymentId },
          encoding: "utf8",
          timeout: 30_000,
          cwd: REPO_ROOT,
        });
      const result = (out: string) =>
        out
          .split("\n")
          .flatMap((l) => {
            try {
              const obj = JSON.parse(l);
              return obj.msg === "init-blob-marker" ? [obj.result] : [];
            } catch {
              return [];
            }
          })[0];

      const first = run(DEPLOYMENT_ID);
      expect(first.status, first.stderr).toBe(0);
      expect(result(first.stdout)).toBe("created");
      const second = run("11111111-1111-4111-8111-111111111111");
      expect(second.status, second.stderr).toBe(0);
      expect(result(second.stdout)).toBe("exists");
      return loadStore().then((store) => expect(store.readMarker()).resolves.toBe(DEPLOYMENT_ID));
    });
  });

  describe("the sweep", () => {
    it("pages through the bucket, cuts at maxObjects mid-page, and resumes there on the next tick", async () => {
      const store = await loadStore();
      await store.createMarker(DEPLOYMENT_ID);
      const live = [await referencedObject(), await referencedObject(), await referencedObject()];
      const orphans = [await orphanObject(), await orphanObject(), await orphanObject()];
      await put(`${prefix}/personal/not-a-uuid/x.bin`);
      const now = new Date((await newestLastModified()) + GRACE_MS + 1);
      const cursor: BlobCursor = { sawReferenced: false };
      const deps = { readRefs, store, now: () => now, log };

      // 8 keys in all, the marker (unparseable) among them; pages of 2 cut to 1 at the 5th key.
      const first = await sweepOrphanBlobs(deps, opts({ maxObjects: 5, pageSize: 2 }), cursor);
      expect(first.listed).toBe(5);
      expect(cursor.value).toBeDefined();
      const second = await sweepOrphanBlobs(deps, opts({ maxObjects: 5, pageSize: 2 }), cursor);
      expect(second.listed).toBe(3);
      expect(first.referenced + second.referenced).toBe(3);
      expect(first.deleted + second.deleted).toBe(3);
      expect(first.unparseable + second.unparseable).toBe(2);
      expect(cursor).toEqual({ value: undefined, sawReferenced: false });
      const left = await keysUnderPrefix();
      for (const key of live) expect(left).toContain(key);
      for (const key of orphans) expect(left).not.toContain(key);
    });

    it("keeps an orphan at LastModified + grace - 1 ms and deletes it at + 1 ms", async () => {
      const store = await loadStore();
      await store.createMarker(DEPLOYMENT_ID);
      await referencedObject();
      const orphan = await orphanObject();
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: orphan }));
      const lastModified = listed.Contents?.[0]?.LastModified?.getTime() ?? NaN;
      expect(Number.isFinite(lastModified)).toBe(true);
      const newest = await newestLastModified();

      const young = await sweepOrphanBlobs(
        { readRefs, store, now: () => new Date(lastModified + GRACE_MS - 1), log },
        opts(),
        { sawReferenced: false },
      );
      // Young: every attachment object listed at or after the orphan's
      // LastModified — the orphan, and the referenced object too when MinIO's
      // 1 s granularity gave both the same second. Not refused: a refusal
      // also deletes nothing.
      const sameSecondOrLater = (await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/personal/` })))
        .Contents?.filter((o) => (o.LastModified?.getTime() ?? 0) >= lastModified).length ?? 0;
      expect(sameSecondOrLater).toBeGreaterThanOrEqual(1);
      expect(young).toMatchObject({ young: sameSecondOrLater, deleted: 0 });
      expect(young.refused).toBeUndefined();
      expect(await keysUnderPrefix()).toContain(orphan);

      const old = await sweepOrphanBlobs(
        { readRefs, store, now: () => new Date(Math.max(lastModified, newest) + GRACE_MS + 1), log },
        opts(),
        { sawReferenced: false },
      );
      expect(old.deleted).toBe(1);
      expect(await keysUnderPrefix()).not.toContain(orphan);
    });

    it("refuses without the marker and with another deployment's marker, deleting nothing", async () => {
      const store = await loadStore();
      await referencedObject();
      const orphan = await orphanObject();
      const now = new Date((await newestLastModified()) + GRACE_MS + 1);
      const missing = await sweepOrphanBlobs({ readRefs, store, now: () => now, log }, opts(), { sawReferenced: false });
      expect(missing.refused).toBe("marker_missing");
      await store.createMarker("11111111-1111-4111-8111-111111111111");
      const mismatch = await sweepOrphanBlobs({ readRefs, store, now: () => now, log }, opts(), { sawReferenced: false });
      expect(mismatch.refused).toBe("marker_mismatch");
      expect(await keysUnderPrefix()).toContain(orphan);
    });

    it("through sweepOnce on the worker role: deletes the orphan, keeps the referenced object, records the count", async () => {
      const store = await loadStore();
      await store.createMarker(DEPLOYMENT_ID);
      const live = await referencedObject();
      const orphan = await orphanObject();
      // The objects were just written; a negative grace makes them "old" for
      // this cell without depending on the container's clock (sweepOnce takes
      // the real time; the grace boundary itself is the cell above).
      const counts = await sweepOnce(ctx.retentionWorker.prisma, 100, {
        intervalMs: 1,
        emitHeartbeatAudit: false,
        blobSweep: { ...opts(), graceMs: -10 * 60_000 },
        blobCursor: { sawReferenced: false },
      });
      expect(counts.attachment_objects).toBe(1);
      const left = await keysUnderPrefix();
      expect(left).toContain(live);
      expect(left).not.toContain(orphan);
    });
  });
});
