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
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import { S3Destination, joinS3Key } from "./s3-destination";

const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;
const ARTIFACT_KEY = "2026-05-02.kid-audit-anchor-abc.jws";

function sentInput(call = 0): Record<string, unknown> {
  const command = sendSpy.mock.calls[call]?.[0] as { input: Record<string, unknown> };
  return command.input;
}

async function uploadOnce(dest: S3Destination, signal?: AbortSignal): Promise<void> {
  await dest.upload({
    artifactBytes: Buffer.from("jws"),
    artifactKey: ARTIFACT_KEY,
    contentType: "application/jose",
    signal,
  });
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

    await dest.upload({ artifactBytes, artifactKey: ARTIFACT_KEY, contentType: "application/jose" });

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sentInput()).toMatchObject({
      Bucket: "my-bucket",
      Key: `anchors/${ARTIFACT_KEY}`,
      Body: artifactBytes,
      ContentType: "application/jose",
    });
  });

  it("stores at the bare artifact key when the prefix is empty", async () => {
    await uploadOnce(new S3Destination({ bucket: "my-bucket", prefix: "" }));

    expect(sentInput()["Key"]).toBe(ARTIFACT_KEY);
  });

  it("sends Object Lock COMPLIANCE with a retain-until date the default retention ahead", async () => {
    const before = Date.now();
    await uploadOnce(new S3Destination({ bucket: "bucket", prefix: "" }));
    const after = Date.now();

    const input = sentInput();
    expect(input["ObjectLockMode"]).toBe("COMPLIANCE");
    const retainUntil = input["ObjectLockRetainUntilDate"] as Date;
    expect(retainUntil).toBeInstanceOf(Date);
    expect(retainUntil.getTime()).toBeGreaterThanOrEqual(before + SEVEN_YEARS_MS);
    expect(retainUntil.getTime()).toBeLessThanOrEqual(after + SEVEN_YEARS_MS);
  });

  it("honours an explicit retentionYears", async () => {
    const before = Date.now();
    await uploadOnce(new S3Destination({ bucket: "bucket", prefix: "", retentionYears: 1 }));
    const after = Date.now();

    const retainUntil = (sentInput()["ObjectLockRetainUntilDate"] as Date).getTime();
    expect(retainUntil).toBeGreaterThanOrEqual(before + SEVEN_YEARS_MS / 7);
    expect(retainUntil).toBeLessThanOrEqual(after + SEVEN_YEARS_MS / 7);
  });

  it("requests SSE-S3 (AES256) server-side encryption", async () => {
    await uploadOnce(new S3Destination({ bucket: "bucket", prefix: "" }));

    expect(sentInput()["ServerSideEncryption"]).toBe("AES256");
  });

  it("passes the caller's signal to client.send as abortSignal", async () => {
    const controller = new AbortController();
    await uploadOnce(new S3Destination({ bucket: "bucket", prefix: "" }), controller.signal);

    expect(sendSpy.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });

  it("creates one client per destination, reused across uploads", async () => {
    const dest = new S3Destination({ bucket: "bucket", prefix: "" });
    await uploadOnce(dest);
    await uploadOnce(dest);

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
      uploadOnce(new S3Destination({ bucket: "bucket", prefix: "" })),
    ).rejects.toThrow("S3 network error");
  });
});
