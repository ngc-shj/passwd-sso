import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { S3Destination } from "./s3-destination";

// --- Mock setup for requireOptionalModule ---

// We intercept the runtime-module helper so the test never touches real AWS SDK.
vi.mock("@/lib/blob-store/runtime-module", () => ({
  requireOptionalModule: vi.fn(),
}));

import { requireOptionalModule } from "@/lib/blob-store/runtime-module";

const mockedRequire = vi.mocked(requireOptionalModule);

describe("S3Destination", () => {
  let sendSpy: ReturnType<typeof vi.fn>;
  let PutObjectCommandSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendSpy = vi.fn().mockResolvedValue({});
    PutObjectCommandSpy = vi.fn().mockImplementation(function (this: Record<string, unknown>, input: unknown) {
      this["_input"] = input;
    });

    function MockS3Client(this: Record<string, unknown>) {
      this["send"] = sendSpy;
    }

    mockedRequire.mockReturnValue({
      S3Client: MockS3Client,
      PutObjectCommand: PutObjectCommandSpy,
    } as unknown as ReturnType<typeof requireOptionalModule>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has name 's3-object-lock'", () => {
    const dest = new S3Destination({ bucket: "my-bucket", prefix: "anchors" });
    expect(dest.name).toBe("s3-object-lock");
  });

  it("constructs PutObjectCommand with correct Bucket, Key, Body, ContentType", async () => {
    const dest = new S3Destination({ bucket: "my-bucket", prefix: "anchors" });
    const artifactBytes = Buffer.from("test-jws-payload");

    await dest.upload({
      artifactBytes,
      artifactKey: "2026-05-02.kid-audit-anchor-abc.jws",
      contentType: "application/jose",
    });

    expect(PutObjectCommandSpy).toHaveBeenCalledOnce();
    const callArg = PutObjectCommandSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg["Bucket"]).toBe("my-bucket");
    expect(callArg["Key"]).toBe("anchors/2026-05-02.kid-audit-anchor-abc.jws");
    expect(callArg["Body"]).toBe(artifactBytes);
    expect(callArg["ContentType"]).toBe("application/jose");
  });

  it("includes Object Lock COMPLIANCE headers", async () => {
    const dest = new S3Destination({ bucket: "my-bucket", prefix: "anchors", retentionYears: 7 });
    const before = Date.now();

    await dest.upload({
      artifactBytes: Buffer.from("jws"),
      artifactKey: "2026-05-02.kid-audit-anchor-abc.jws",
      contentType: "application/jose",
    });

    const callArg = PutObjectCommandSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg["ObjectLockMode"]).toBe("COMPLIANCE");

    const retainUntil = callArg["ObjectLockRetainUntilDate"] as Date;
    expect(retainUntil).toBeInstanceOf(Date);

    // Retain date should be ~7 years in the future (±5s tolerance for test speed)
    const expectedMs = before + 7 * 365 * 24 * 60 * 60 * 1000;
    expect(retainUntil.getTime()).toBeGreaterThanOrEqual(expectedMs - 5000);
    expect(retainUntil.getTime()).toBeLessThanOrEqual(expectedMs + 5000);
  });

  it("uses empty prefix when prefix is empty string", async () => {
    const dest = new S3Destination({ bucket: "my-bucket", prefix: "" });

    await dest.upload({
      artifactBytes: Buffer.from("jws"),
      artifactKey: "2026-05-02.kid-audit-anchor-abc.jws",
      contentType: "application/jose",
    });

    const callArg = PutObjectCommandSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg["Key"]).toBe("2026-05-02.kid-audit-anchor-abc.jws");
  });

  it("calls client.send with the constructed command", async () => {
    const dest = new S3Destination({ bucket: "bucket", prefix: "" });

    await dest.upload({
      artifactBytes: Buffer.from("jws"),
      artifactKey: "artifact.jws",
      contentType: "application/jose",
    });

    expect(sendSpy).toHaveBeenCalledOnce();
    // The argument passed to send is the PutObjectCommand instance
    const commandInstance = sendSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(commandInstance["_input"]).toMatchObject({ Bucket: "bucket" });
  });

  it("propagates upload errors from client.send", async () => {
    sendSpy.mockRejectedValue(new Error("S3 network error"));
    const dest = new S3Destination({ bucket: "bucket", prefix: "" });

    await expect(
      dest.upload({
        artifactBytes: Buffer.from("jws"),
        artifactKey: "artifact.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow("S3 network error");
  });

  it("uses default AUDIT_ANCHOR_RETENTION_YEARS when retentionYears not specified", async () => {
    const dest = new S3Destination({ bucket: "bucket", prefix: "" });
    const before = Date.now();

    await dest.upload({
      artifactBytes: Buffer.from("jws"),
      artifactKey: "artifact.jws",
      contentType: "application/jose",
    });

    const callArg = PutObjectCommandSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const retainUntil = callArg["ObjectLockRetainUntilDate"] as Date;

    // AUDIT_ANCHOR_RETENTION_YEARS = 7
    const expectedMs = before + 7 * 365 * 24 * 60 * 60 * 1000;
    expect(retainUntil.getTime()).toBeGreaterThanOrEqual(expectedMs - 5000);
    expect(retainUntil.getTime()).toBeLessThanOrEqual(expectedMs + 5000);
  });
});
