/**
 * S3Destination against MinIO, the S3 stand-in locally and in CI.
 *
 * MinIO is required: set ANCHOR_TEST_S3_ENDPOINT (e.g. http://127.0.0.1:9000)
 * to a MinIO started with the root credentials minioadmin/minioadmin and a KMS
 * key (MINIO_KMS_SECRET_KEY) — without one MinIO answers 501 to the SSE-S3
 * header the destination always sends. A missing or unready endpoint fails the
 * suite; it never skips.
 *
 * Objects under COMPLIANCE retention cannot be deleted, so every case writes
 * under a prefix of its own: uniqueness comes from the prefix, never the key.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  S3Destination,
  joinS3Key,
  type S3DestinationClientOptions,
} from "@/lib/audit/anchor-destinations/s3-destination";
import { AUDIT_ANCHOR_RETENTION_YEARS } from "@/lib/constants/audit/audit";
import { MS_PER_DAY, MS_PER_SECOND } from "@/lib/constants/time";
import {
  createArtifact,
  describeAnchorDestinationContract,
  expectOneConcurrentCreateWins,
  manifestKeyFor,
} from "../helpers/anchor-destination-contract";

const ENDPOINT_ENV = "ANCHOR_TEST_S3_ENDPOINT";
const LOCKED_BUCKET = "anchor-test-object-lock";
const UNLOCKED_BUCKET = "anchor-test-no-object-lock";
const CONTENT_TYPE = "application/jose";
const RETENTION_MS = AUDIT_ANCHOR_RETENTION_YEARS * 365 * MS_PER_DAY;

let clientOptions: S3DestinationClientOptions;
let admin: S3Client;

async function ensureBucket(bucket: string, objectLock: boolean): Promise<void> {
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(
      new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: objectLock }),
    );
  }
}

function freshPrefix(): string {
  return `audit-anchors/${randomUUID()}`;
}

function lockedDestination(prefix = freshPrefix(), listPageSize?: number): S3Destination {
  return new S3Destination({ bucket: LOCKED_BUCKET, prefix, clientOptions, listPageSize });
}

async function versionCount(bucket: string, key: string): Promise<number> {
  const { Versions } = await admin.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  return (Versions ?? []).filter((v) => v.Key === key).length;
}

beforeAll(async () => {
  const endpoint = process.env[ENDPOINT_ENV];
  if (!endpoint) {
    throw new Error(
      `${ENDPOINT_ENV} is not set. Start MinIO (with MINIO_KMS_SECRET_KEY) and export ` +
        `${ENDPOINT_ENV}=http://127.0.0.1:9000 to run the S3 destination tests.`,
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
  await ensureBucket(LOCKED_BUCKET, true);
  await ensureBucket(UNLOCKED_BUCKET, false);
});

describeAnchorDestinationContract("S3 (MinIO, Object Lock bucket)", () => lockedDestination());

describe("S3Destination — MinIO integration", () => {
  // E2 probe, run with the raw SDK so a gap is reported apart from the
  // destination's own behaviour: does this MinIO release honour the Object
  // Lock retention headers at all?
  it("MinIO honours COMPLIANCE retention headers on an Object Lock bucket (E2 probe)", async () => {
    const key = joinS3Key(freshPrefix(), manifestKeyFor("2026-05-02"));
    const retainUntil = new Date(Date.now() + MS_PER_DAY);

    await admin.send(
      new PutObjectCommand({
        Bucket: LOCKED_BUCKET,
        Key: key,
        Body: Buffer.from("probe"),
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );

    const { Retention } = await admin.send(
      new GetObjectRetentionCommand({ Bucket: LOCKED_BUCKET, Key: key }),
    );
    expect(Retention?.Mode).toBe("COMPLIANCE");
    expect(Retention?.RetainUntilDate?.getTime()).toBe(retainUntil.getTime());
  });

  it("create stores the artifact under COMPLIANCE retention at the default retention date, SSE-S3 encrypted", async () => {
    const prefix = freshPrefix();
    const dest = lockedDestination(prefix);
    const key = manifestKeyFor("2026-05-02");
    const body = Buffer.from(`signed-manifest-${randomUUID()}`);

    const before = Date.now();
    expect(await dest.create({ artifactBytes: body, artifactKey: key, contentType: CONTENT_TYPE })).toBe("created");
    const after = Date.now();

    const storedKey = joinS3Key(prefix, key);
    const { Retention } = await admin.send(
      new GetObjectRetentionCommand({ Bucket: LOCKED_BUCKET, Key: storedKey }),
    );
    expect(Retention?.Mode).toBe("COMPLIANCE");
    const retainUntil = Retention?.RetainUntilDate?.getTime() ?? Number.NaN;
    // S3 may store the date at second precision.
    expect(retainUntil).toBeGreaterThanOrEqual(
      Math.floor((before + RETENTION_MS) / MS_PER_SECOND) * MS_PER_SECOND,
    );
    expect(retainUntil).toBeLessThanOrEqual(after + RETENTION_MS);

    const head = await admin.send(new HeadObjectCommand({ Bucket: LOCKED_BUCKET, Key: storedKey }));
    expect(head.ServerSideEncryption).toBe("AES256");
    expect(head.ContentType).toBe(CONTENT_TYPE);

    const got = await admin.send(new GetObjectCommand({ Bucket: LOCKED_BUCKET, Key: storedKey }));
    expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(body);
  });

  it("a second create of the key writes no second version", async () => {
    const prefix = freshPrefix();
    const dest = lockedDestination(prefix);
    const key = manifestKeyFor("2026-05-02");

    expect(await createArtifact(dest, key, Buffer.from("first"))).toBe("created");
    expect(await createArtifact(dest, key, Buffer.from("second"))).toBe("exists");

    expect(await versionCount(LOCKED_BUCKET, joinS3Key(prefix, key))).toBe(1);
  });

  it("eight concurrent creates of one key: one is created, and the key holds one version", async () => {
    const prefix = freshPrefix();
    const key = manifestKeyFor("2026-05-02");

    await expectOneConcurrentCreateWins(lockedDestination(prefix), key);

    expect(await versionCount(LOCKED_BUCKET, joinS3Key(prefix, key))).toBe(1);
  });

  it("lists every page: 5 keys at page size 2 give the exact set", async () => {
    const prefix = freshPrefix();
    const dest = lockedDestination(prefix, 2);
    const keys = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"].map((d) => manifestKeyFor(d));
    for (const key of keys) await createArtifact(dest, key, Buffer.from(key));

    expect([...(await dest.list())].sort()).toEqual([...keys].sort());
  });

  it("lists and reads only under its own prefix, not a sibling that starts with it", async () => {
    const prefix = freshPrefix();
    const key = manifestKeyFor("2026-05-02");
    await createArtifact(lockedDestination(`${prefix}-sibling`), key, Buffer.from("sibling"));
    const dest = lockedDestination(prefix);

    expect(await dest.list()).toEqual([]);
    expect(await dest.read(key)).toBeNull();
  });

  it("the same create to a bucket without Object Lock is refused", async () => {
    const prefix = freshPrefix();
    const dest = new S3Destination({ bucket: UNLOCKED_BUCKET, prefix, clientOptions });
    const key = manifestKeyFor("2026-05-02");

    const refusal = await dest
      .create({ artifactBytes: Buffer.from("jws"), artifactKey: key, contentType: CONTENT_TYPE })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The refusal must be the missing lock configuration, not some other
    // rejection (an SSE or credentials error would pass a bare rejects check).
    expect(refusal).toBeInstanceOf(S3ServiceException);
    expect((refusal as S3ServiceException).$metadata.httpStatusCode).toBe(400);
    expect((refusal as S3ServiceException).message).toMatch(/ObjectLockConfiguration/);

    const stored = await admin
      .send(new HeadObjectCommand({ Bucket: UNLOCKED_BUCKET, Key: joinS3Key(prefix, key) }))
      .then(
        () => true,
        () => false,
      );
    expect(stored).toBe(false);
  });
});
