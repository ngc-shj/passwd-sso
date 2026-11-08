import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOB_STORAGE } from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import { s3BlobStore } from "@/lib/blob-store/s3-blob-store";
import { encodeObjectRef } from "@/lib/blob-store/object-ref";
import type { ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";

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

describe("s3BlobStore client options", () => {
  it.each([
    ["true", true],
    ["", false],
  ])("S3_FORCE_PATH_STYLE=%j constructs the client with forcePathStyle %s", async (value, want) => {
    vi.resetModules();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");
    vi.stubEnv("S3_FORCE_PATH_STYLE", value);
    const constructed: unknown[] = [];
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        S3Client: class {
          constructor(options: unknown) {
            constructed.push(options);
          }
          send = vi.fn().mockResolvedValue({});
        },
        PutObjectCommand: class {},
        GetObjectCommand: class {},
        DeleteObjectCommand: class {},
      }),
    }));
    const { s3BlobStore: store } = await import("./s3-blob-store");

    await store.putObject(new Uint8Array([1]), {
      attachmentId: "att-1",
      entryId: "entry-1",
      generation: "0123456789abcdef0123456789abcdef",
    });

    expect(constructed).toEqual([{ region: "ap-northeast-1", forcePathStyle: want }]);
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

describe("s3BlobStore listing and marker", () => {
  // Fixtures are typed against the SDK's own output type, so a field the
  // store reads that the SDK does not return is a compile error here.
  type ListPage = Pick<ListObjectsV2CommandOutput, "Contents" | "IsTruncated" | "NextContinuationToken">;
  const T0 = new Date("2026-01-01T00:00:00Z");

  class ListObjectsV2Command {
    constructor(readonly input: { Prefix: string; MaxKeys: number; ContinuationToken?: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class PutObjectCommand {
    constructor(readonly input: { Key: string; IfNoneMatch?: string; Body: Buffer }) {}
  }

  async function loadStore(send: (command: unknown) => Promise<unknown>, prefix = "") {
    vi.resetModules();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("S3_ATTACHMENTS_BUCKET", "attachments-bucket");
    vi.stubEnv("BLOB_OBJECT_PREFIX", prefix);
    const sendMock = vi.fn(send);
    vi.doMock("./runtime-module", () => ({
      requireOptionalModule: vi.fn().mockReturnValue({
        S3Client: class {
          send = sendMock;
        },
        PutObjectCommand,
        GetObjectCommand,
        DeleteObjectCommand: class {},
        ListObjectsV2Command,
      }),
    }));
    vi.doMock("./stream", () => ({ streamBodyToBuffer: async (b: Buffer) => b }));
    const { s3BlobStore: store } = await import("./s3-blob-store");
    return { store, send: sendMock };
  }

  it("returns an empty page and no cursor for an empty listing", async () => {
    const page: ListPage = { IsTruncated: false };
    const { store, send } = await loadStore(async () => page);
    await expect(store.listObjects("p/", { pageSize: 10 })).resolves.toEqual({ objects: [] });
    expect((send.mock.calls[0][0] as ListObjectsV2Command).input).toMatchObject({ Prefix: "p/", MaxKeys: 10 });
  });

  it("returns the continuation token while truncated and passes it back", async () => {
    const pages: ListPage[] = [
      { Contents: [{ Key: "a", LastModified: T0 }], IsTruncated: true, NextContinuationToken: "tok-1" },
      { Contents: [{ Key: "b", LastModified: T0 }], IsTruncated: false },
    ];
    const { store, send } = await loadStore(async () => pages.shift());
    const first = await store.listObjects("", { pageSize: 1 });
    expect(first).toEqual({ objects: [{ key: "a", lastModified: T0 }], cursor: "tok-1" });
    const second = await store.listObjects("", { pageSize: 1, cursor: first.cursor });
    expect(second).toEqual({ objects: [{ key: "b", lastModified: T0 }] });
    expect((send.mock.calls[1][0] as ListObjectsV2Command).input.ContinuationToken).toBe("tok-1");
  });

  it.each([
    ["an empty final token", ""],
    ["an absent final token", undefined],
  ])("treats %s as the end of the listing", async (_label, token) => {
    const page: ListPage = { Contents: [], IsTruncated: true, NextContinuationToken: token };
    const { store } = await loadStore(async () => page);
    expect((await store.listObjects("", { pageSize: 5 })).cursor).toBeUndefined();
  });

  it("readMarker returns null when the marker is absent (404)", async () => {
    const { store } = await loadStore(async () => {
      throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    });
    await expect(store.readMarker()).resolves.toBeNull();
  });

  it("readMarker rethrows any other failure", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    const { store } = await loadStore(async () => {
      throw denied;
    });
    await expect(store.readMarker()).rejects.toBe(denied);
  });

  it("readMarker returns the body of the marker under the prefix", async () => {
    const { store, send } = await loadStore(async () => ({ Body: Buffer.from("deployment-1") }), "tenant-a");
    await expect(store.readMarker()).resolves.toBe("deployment-1");
    expect((send.mock.calls[0][0] as GetObjectCommand).input.Key).toBe("tenant-a/.passwd-sso-deployment");
  });

  it("createMarker sends a conditional create and reports created", async () => {
    const { store, send } = await loadStore(async () => ({}));
    await expect(store.createMarker("deployment-1")).resolves.toBe("created");
    const input = (send.mock.calls[0][0] as PutObjectCommand).input;
    expect(input).toMatchObject({ Key: ".passwd-sso-deployment", IfNoneMatch: "*" });
    expect(input.Body.toString("utf8")).toBe("deployment-1");
  });

  it("createMarker on an existing marker reports exists (412) and sends nothing else", async () => {
    const { store, send } = await loadStore(async () => {
      throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    });
    await expect(store.createMarker("deployment-2")).resolves.toBe("exists");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
