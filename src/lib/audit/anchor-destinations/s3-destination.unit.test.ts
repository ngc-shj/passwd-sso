import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendSpy, s3ClientCtorSpy } = vi.hoisted(() => ({
  sendSpy: vi.fn(),
  s3ClientCtorSpy: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sendSpy;
    constructor(config: unknown) {
      s3ClientCtorSpy(config);
    }
  },
  PutObjectCommand: class {
    readonly kind = "put";
    constructor(readonly input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    readonly kind = "get";
    constructor(readonly input: Record<string, unknown>) {}
  },
  ListObjectsV2Command: class {
    readonly kind = "list";
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import { S3Destination, joinS3Key, s3ListPrefix, s3Location } from "./s3-destination";
import { ArtifactTooLargeError } from "./destination";
import { ANCHOR_ARTIFACT_CONTENT_TYPE, InvalidArtifactKeyError } from "@/lib/audit/anchor-artifact-keys";
import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES, AUDIT_ANCHOR_RETENTION_YEARS } from "@/lib/constants/audit/audit";
import { MS_PER_DAY } from "@/lib/constants/time";

const YEAR_MS = 365 * MS_PER_DAY;
const DEFAULT_RETENTION_MS = AUDIT_ANCHOR_RETENTION_YEARS * YEAR_MS;
const ARTIFACT_KEY = "2026-05-02.kid-audit-anchor-0123456789abcdef.jws";

function sentInput(call = 0): Record<string, unknown> {
  const command = sendSpy.mock.calls[call]?.[0] as { input: Record<string, unknown> };
  return command.input;
}

function sentKinds(): unknown[] {
  return sendSpy.mock.calls.map(([command]) => (command as { kind: string }).kind);
}

async function createOnce(dest: S3Destination, signal?: AbortSignal): Promise<"created" | "exists"> {
  return dest.create({
    artifactBytes: Buffer.from("jws"),
    artifactKey: ARTIFACT_KEY,
    contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS,
    signal,
  });
}

/** An S3 service error as the SDK raises it: the HTTP status under `$metadata`. */
function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

function body(bytes: Buffer) {
  return { transformToByteArray: async () => new Uint8Array(bytes) };
}

describe("joinS3Key", () => {
  it("joins a non-empty prefix with a single slash", () => {
    expect(joinS3Key("audit-anchors", ARTIFACT_KEY)).toBe(`audit-anchors/${ARTIFACT_KEY}`);
  });

  it("returns the artifact key unchanged for an empty prefix", () => {
    expect(joinS3Key("", ARTIFACT_KEY)).toBe(ARTIFACT_KEY);
  });
});

describe("S3Destination", () => {
  beforeEach(() => {
    sendSpy.mockReset().mockResolvedValue({});
    s3ClientCtorSpy.mockReset();
  });

  it("has name 's3-object-lock'", () => {
    const dest = new S3Destination({ bucket: "my-bucket", prefix: "anchors" });
    expect(dest.name).toBe("s3-object-lock");
  });

  it("sends Bucket, the prefix-joined Key, Body and ContentType", async () => {
    const dest = new S3Destination({ bucket: "my-bucket", prefix: "anchors" });
    const artifactBytes = Buffer.from("test-jws-payload");

    await dest.create({ artifactBytes, artifactKey: ARTIFACT_KEY, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS });

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sentInput()).toMatchObject({
      Bucket: "my-bucket",
      Key: `anchors/${ARTIFACT_KEY}`,
      Body: artifactBytes,
      ContentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS,
    });
  });

  it("stores at the bare artifact key when the prefix is empty", async () => {
    await createOnce(new S3Destination({ bucket: "my-bucket", prefix: "" }));

    expect(sentInput()["Key"]).toBe(ARTIFACT_KEY);
  });

  it("sends Object Lock COMPLIANCE with a retain-until date the default retention ahead", async () => {
    const before = Date.now();
    await createOnce(new S3Destination({ bucket: "bucket", prefix: "" }));
    const after = Date.now();

    const input = sentInput();
    expect(input["ObjectLockMode"]).toBe("COMPLIANCE");
    const retainUntil = input["ObjectLockRetainUntilDate"] as Date;
    expect(retainUntil).toBeInstanceOf(Date);
    expect(retainUntil.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_RETENTION_MS);
    expect(retainUntil.getTime()).toBeLessThanOrEqual(after + DEFAULT_RETENTION_MS);
  });

  it("honours an explicit retentionYears", async () => {
    const before = Date.now();
    await createOnce(new S3Destination({ bucket: "bucket", prefix: "", retentionYears: 1 }));
    const after = Date.now();

    const retainUntil = (sentInput()["ObjectLockRetainUntilDate"] as Date).getTime();
    expect(retainUntil).toBeGreaterThanOrEqual(before + YEAR_MS);
    expect(retainUntil).toBeLessThanOrEqual(after + YEAR_MS);
  });

  it("requests SSE-S3 (AES256) server-side encryption", async () => {
    await createOnce(new S3Destination({ bucket: "bucket", prefix: "" }));

    expect(sentInput()["ServerSideEncryption"]).toBe("AES256");
  });

  it("passes the caller's signal to client.send as abortSignal", async () => {
    const controller = new AbortController();
    await createOnce(new S3Destination({ bucket: "bucket", prefix: "" }), controller.signal);

    expect(sendSpy.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });

  it("creates one client per destination, reused across creates", async () => {
    const dest = new S3Destination({ bucket: "bucket", prefix: "" });
    await createOnce(dest);
    await createOnce(dest);

    expect(s3ClientCtorSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("builds the client from clientOptions plus bounded request timeouts", () => {
    const clientOptions = {
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    };
    new S3Destination({ bucket: "bucket", prefix: "", clientOptions });

    expect(s3ClientCtorSpy).toHaveBeenCalledWith({
      ...clientOptions,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: 30_000,
        throwOnRequestTimeout: true,
      },
    });
  });

  it("defaults clientOptions to none, leaving region and credentials to the SDK chain", () => {
    new S3Destination({ bucket: "bucket", prefix: "" });

    const config = s3ClientCtorSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(config)).toEqual(["requestHandler"]);
  });

  it("propagates upload errors from client.send", async () => {
    sendSpy.mockRejectedValue(new Error("S3 network error"));

    await expect(
      createOnce(new S3Destination({ bucket: "bucket", prefix: "" })),
    ).rejects.toThrow("S3 network error");
    expect(sendSpy).toHaveBeenCalledOnce();
  });
});

describe("S3Destination.create — create-only", () => {
  beforeEach(() => {
    sendSpy.mockReset().mockResolvedValue({});
  });

  const dest = () => new S3Destination({ bucket: "bucket", prefix: "anchors" });

  it("sends If-None-Match: * and answers created", async () => {
    expect(await createOnce(dest())).toBe("created");
    expect(sentInput()["IfNoneMatch"]).toBe("*");
  });

  it("answers exists on 412, without a second request", async () => {
    sendSpy.mockRejectedValueOnce(s3Error("PreconditionFailed", 412));

    expect(await createOnce(dest())).toBe("exists");
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it("retries a 409 and answers created when the retry succeeds", async () => {
    sendSpy.mockRejectedValueOnce(s3Error("ConditionalRequestConflict", 409));

    expect(await createOnce(dest())).toBe("created");
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sentInput(1)["IfNoneMatch"]).toBe("*");
  });

  it("answers exists when a 409's retry finds the key taken", async () => {
    sendSpy
      .mockRejectedValueOnce(s3Error("ConditionalRequestConflict", 409))
      .mockRejectedValueOnce(s3Error("PreconditionFailed", 412));

    expect(await createOnce(dest())).toBe("exists");
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("answers created on the last retry: two 409s, then success", async () => {
    sendSpy
      .mockRejectedValueOnce(s3Error("ConditionalRequestConflict", 409))
      .mockRejectedValueOnce(s3Error("ConditionalRequestConflict", 409));

    expect(await createOnce(dest())).toBe("created");
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it("throws the third 409 in a row, after two retries", async () => {
    sendSpy.mockRejectedValue(s3Error("ConditionalRequestConflict", 409));

    await expect(createOnce(dest())).rejects.toMatchObject({ name: "ConditionalRequestConflict" });
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it("refuses a key of no known shape and an artifact past the size bound, sending nothing", async () => {
    await expect(
      dest().create({ artifactBytes: Buffer.from("x"), artifactKey: "notes.txt", contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.PUBLIC_KEY }),
    ).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(
      dest().create({
        artifactBytes: Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1),
        artifactKey: ARTIFACT_KEY,
        contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS,
      }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("S3Destination.read", () => {
  beforeEach(() => {
    sendSpy.mockReset();
  });

  const dest = () => new S3Destination({ bucket: "bucket", prefix: "anchors" });
  const STORED_KEY = `anchors/${ARTIFACT_KEY}`;

  it("decides absence from a listing under the key, sending no GET", async () => {
    sendSpy.mockResolvedValueOnce({ Contents: [] });

    expect(await dest().read(ARTIFACT_KEY)).toBeNull();
    expect(sentKinds()).toEqual(["list"]);
    expect(sentInput()).toEqual({ Bucket: "bucket", Prefix: STORED_KEY, MaxKeys: 1 });
  });

  it("reads null when the listing's first key only starts with the key", async () => {
    sendSpy.mockResolvedValueOnce({ Contents: [{ Key: `${STORED_KEY}.bak` }] });

    expect(await dest().read(ARTIFACT_KEY)).toBeNull();
    expect(sentKinds()).toEqual(["list"]);
  });

  it("returns the listed key's bytes, passing the signal to both requests", async () => {
    const controller = new AbortController();
    sendSpy
      .mockResolvedValueOnce({ Contents: [{ Key: STORED_KEY }] })
      .mockResolvedValueOnce({ ContentLength: 3, Body: body(Buffer.from("jws")) });

    expect(await dest().read(ARTIFACT_KEY, controller.signal)).toEqual(Buffer.from("jws"));
    expect(sentKinds()).toEqual(["list", "get"]);
    expect(sentInput(1)).toEqual({ Bucket: "bucket", Key: STORED_KEY });
    expect(sendSpy.mock.calls.map((call) => call[1])).toEqual([
      { abortSignal: controller.signal },
      { abortSignal: controller.signal },
    ]);
  });

  it("throws, not null, when the GET of a listed key fails", async () => {
    sendSpy
      .mockResolvedValueOnce({ Contents: [{ Key: STORED_KEY }] })
      .mockRejectedValueOnce(s3Error("AccessDenied", 403));

    await expect(dest().read(ARTIFACT_KEY)).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("throws past the size bound from the declared length, without reading the body", async () => {
    const transformToByteArray = vi.fn();
    sendSpy
      .mockResolvedValueOnce({ Contents: [{ Key: STORED_KEY }] })
      .mockResolvedValueOnce({ ContentLength: AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1, Body: { transformToByteArray } });

    await expect(dest().read(ARTIFACT_KEY)).rejects.toBeInstanceOf(ArtifactTooLargeError);
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("throws past the size bound from the bytes read when no length was declared", async () => {
    sendSpy
      .mockResolvedValueOnce({ Contents: [{ Key: STORED_KEY }] })
      .mockResolvedValueOnce({ Body: body(Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1)) });

    await expect(dest().read(ARTIFACT_KEY)).rejects.toBeInstanceOf(ArtifactTooLargeError);
  });

  it("refuses a key of no known shape, sending nothing", async () => {
    await expect(dest().read("notes.txt")).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("S3Destination.list", () => {
  beforeEach(() => {
    sendSpy.mockReset();
  });

  it("lists under the prefix with a trailing slash and strips it from every key", async () => {
    sendSpy.mockResolvedValueOnce({
      Contents: [{ Key: `anchors/${ARTIFACT_KEY}` }, { Key: "anchors/public-keys/k.pub" }],
    });
    const controller = new AbortController();

    const keys = await new S3Destination({ bucket: "bucket", prefix: "anchors" }).list(controller.signal);

    expect(keys).toEqual([ARTIFACT_KEY, "public-keys/k.pub"]);
    expect(sentInput()).toEqual({
      Bucket: "bucket",
      Prefix: s3ListPrefix("anchors"),
      MaxKeys: undefined,
      ContinuationToken: undefined,
    });
    expect(sentInput()["Prefix"]).toBe("anchors/");
    expect(sendSpy.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });

  it("follows the continuation token until a page is not truncated, at the configured page size", async () => {
    sendSpy
      .mockResolvedValueOnce({ Contents: [{ Key: "a" }, { Key: "b" }], IsTruncated: true, NextContinuationToken: "t1" })
      .mockResolvedValueOnce({ Contents: [{ Key: "c" }, { Key: "d" }], IsTruncated: true, NextContinuationToken: "t2" })
      .mockResolvedValueOnce({ Contents: [{ Key: "e" }], IsTruncated: false });

    const keys = await new S3Destination({ bucket: "bucket", prefix: "", listPageSize: 2 }).list();

    expect(keys).toEqual(["a", "b", "c", "d", "e"]);
    expect(sendSpy.mock.calls.map(([command]) => (command as { input: Record<string, unknown> }).input)).toEqual([
      { Bucket: "bucket", Prefix: "", MaxKeys: 2, ContinuationToken: undefined },
      { Bucket: "bucket", Prefix: "", MaxKeys: 2, ContinuationToken: "t1" },
      { Bucket: "bucket", Prefix: "", MaxKeys: 2, ContinuationToken: "t2" },
    ]);
  });

  it("lists nothing for an empty prefix", async () => {
    sendSpy.mockResolvedValueOnce({});

    expect(await new S3Destination({ bucket: "bucket", prefix: "anchors" }).list()).toEqual([]);
  });
});

describe("s3Location", () => {
  it("names the bucket and the prefix, and the bucket alone for an empty prefix", () => {
    expect(s3Location("my-bucket", "audit-anchors")).toBe("s3://my-bucket/audit-anchors");
    expect(s3Location("my-bucket", "env/prod.anchors")).toBe("s3://my-bucket/env/prod.anchors");
    expect(s3Location("my-bucket", "")).toBe("s3://my-bucket");
  });

  it("is the destination's location, apart for two prefixes of one bucket", () => {
    const one = new S3Destination({ bucket: "my-bucket", prefix: "audit-anchors" });
    const other = new S3Destination({ bucket: "my-bucket", prefix: "audit-anchors-2" });

    expect(one.location).toBe("s3://my-bucket/audit-anchors");
    expect(other.location).toBe("s3://my-bucket/audit-anchors-2");
    expect(new S3Destination({ bucket: "my-bucket", prefix: "" }).location).toBe("s3://my-bucket");
  });
});

describe("s3ListPrefix", () => {
  it("ends a non-empty prefix with one slash and leaves an empty one empty", () => {
    expect(s3ListPrefix("audit-anchors")).toBe("audit-anchors/");
    expect(s3ListPrefix("env/prod.anchors")).toBe("env/prod.anchors/");
    expect(s3ListPrefix("")).toBe("");
  });
});
