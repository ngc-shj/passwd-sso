import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOB_STORAGE } from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import { s3BlobStore } from "@/lib/blob-store/s3-blob-store";
import { encodeObjectRef } from "@/lib/blob-store/object-ref";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("s3BlobStore.validateConfig", () => {
  it("throws when required env is missing", () => {
    vi.unstubAllEnvs();
    expect(() => s3BlobStore.validateConfig()).toThrow(
      "S3 backend requires AWS_REGION and S3_ATTACHMENTS_BUCKET",
    );
  });

  it("passes when required env is present", () => {
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");
    expect(() => s3BlobStore.validateConfig()).not.toThrow();
  });
});

describe("s3BlobStore lazy SDK loading", () => {
  it("loads sdk only when object operation runs", async () => {
    vi.resetModules();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");

    const send = vi.fn().mockResolvedValue({});
    const requireOptionalModule = vi.fn().mockReturnValue({
      S3Client: class {
        send = send;
      },
      PutObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
      GetObjectCommand: class {},
      DeleteObjectCommand: class {},
    });

    vi.doMock("./runtime-module", () => ({
      requireOptionalModule,
    }));

    const { s3BlobStore: store } = await import("./s3-blob-store");

    store.validateConfig();
    expect(requireOptionalModule).not.toHaveBeenCalled();

    await store.putObject(new Uint8Array([1, 2, 3]), {
      attachmentId: "att-1",
      entryId: "entry-1",
      generation: "0123456789abcdef0123456789abcdef",
    });

    expect(loadCloudBlobConfig(BLOB_STORAGE.S3).bucket).toBe("attachments-bucket");
    expect(requireOptionalModule).toHaveBeenCalledWith("@aws-sdk/client-s3");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("s3BlobStore object keys", () => {
  const GEN = "0123456789abcdef0123456789abcdef";
  const context = { attachmentId: "att-1", entryId: "entry-1", teamId: "team-1" };

  async function loadStore() {
    vi.resetModules();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");
    const send = vi.fn().mockResolvedValue({ Body: Buffer.from([7]) });
    class Command {
      constructor(readonly input: { Key: string }) {}
    }
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        S3Client: class {
          send = send;
        },
        PutObjectCommand: Command,
        GetObjectCommand: Command,
        DeleteObjectCommand: Command,
      }),
    }));
    vi.doMock("./stream", () => ({ streamBodyToBuffer: async (b: Buffer) => b }));
    const { s3BlobStore: store } = await import("./s3-blob-store");
    // Same module instance as the reloaded store (resetModules above).
    const { BlobRefInvalidError } = await import("./object-ref");
    return { store, send, BlobRefInvalidError };
  }

  it("putObject writes the generation key and returns its ref", async () => {
    const { store, send } = await loadStore();
    const stored = await store.putObject(new Uint8Array([1]), { ...context, generation: GEN });
    const key = `team/team-1/entry-1/att-1/${GEN}.bin`;
    expect(send.mock.calls[0][0].input.Key).toBe(key);
    expect(Buffer.from(stored).toString("utf8")).toBe(JSON.stringify({ key }));
  });

  it.each(["getObject", "deleteObject"] as const)("%s reads the row's own stored key", async (op) => {
    const { store, send } = await loadStore();
    const key = `team/team-1/entry-1/att-1.bin`;
    await store[op](encodeObjectRef({ key }), context);
    expect(send.mock.calls[0][0].input.Key).toBe(key);
  });

  it.each([
    ["getObject", "an undecodable ref", new Uint8Array(Buffer.from("raw-bytes"))],
    ["deleteObject", "an undecodable ref", new Uint8Array(Buffer.from("raw-bytes"))],
    ["getObject", "another row's ref", encodeObjectRef({ key: `team/team-1/entry-1/att-2/${GEN}.bin` })],
    ["deleteObject", "another row's ref", encodeObjectRef({ key: `team/team-1/entry-1/att-2/${GEN}.bin` })],
  ] as const)("%s fails closed on %s without touching storage", async (op, _label, stored) => {
    const { store, send, BlobRefInvalidError } = await loadStore();
    await expect(store[op](stored, context)).rejects.toBeInstanceOf(BlobRefInvalidError);
    expect(send).not.toHaveBeenCalled();
  });
});
