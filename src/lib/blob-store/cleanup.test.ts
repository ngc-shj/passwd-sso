import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLOB_STORAGE } from "./types";
import type { AttachmentBlobStore, BlobBackend } from "./types";
import {
  collectEntryAttachmentRefs,
  collectAttachmentRefsByCreator,
  deleteAttachmentBlobs,
  type AttachmentBlobRef,
} from "./cleanup";
import { encodeObjectRef } from "./object-ref";

const { mockGetAttachmentBlobStore, mockWarn } = vi.hoisted(() => ({
  mockGetAttachmentBlobStore: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: mockGetAttachmentBlobStore,
  BLOB_STORAGE,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn }),
}));

const GEN = "0123456789abcdef0123456789abcdef";
const refBytes = (key: string) => encodeObjectRef({ key });

const mockDeleteObject = vi.fn();
const mockFindMany = vi.fn();

function fakeStore(backend: BlobBackend): AttachmentBlobStore {
  return {
    backend,
    deleteObject: mockDeleteObject,
  } as unknown as AttachmentBlobStore;
}

// Minimal stub matching the TxOrPrisma surface cleanup.ts touches.
const client = {
  attachment: { findMany: mockFindMany },
} as never;

beforeEach(() => {
  mockGetAttachmentBlobStore.mockReset();
  mockDeleteObject.mockReset();
  mockFindMany.mockReset();
  mockWarn.mockReset();
  mockDeleteObject.mockResolvedValue(undefined);
});

describe("collectEntryAttachmentRefs", () => {
  it("returns [] without querying on the DB backend", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.DB));

    const refs = await collectEntryAttachmentRefs(client, {
      kind: "personal",
      entryIds: ["e1"],
    });

    expect(refs).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns [] without querying when entryIds is empty", async () => {
    const refs = await collectEntryAttachmentRefs(client, {
      kind: "personal",
      entryIds: [],
    });

    expect(refs).toEqual([]);
    expect(mockGetAttachmentBlobStore).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("personal scope: queries by passwordEntryId and builds context without teamId", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.S3));
    const bytes = new Uint8Array([1, 2, 3]);
    mockFindMany.mockResolvedValue([
      {
        id: "att1",
        encryptedData: bytes,
        passwordEntryId: "pe1",
        teamPasswordEntryId: null,
      },
    ]);

    const refs = await collectEntryAttachmentRefs(client, {
      kind: "personal",
      entryIds: ["pe1"],
    });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { passwordEntryId: { in: ["pe1"] } },
      select: {
        id: true,
        encryptedData: true,
        passwordEntryId: true,
        teamPasswordEntryId: true,
      },
    });
    expect(refs).toEqual([
      { stored: bytes, context: { attachmentId: "att1", entryId: "pe1" } },
    ]);
    expect("teamId" in refs[0].context).toBe(false);
  });

  it("team scope: queries by teamPasswordEntryId and includes teamId in context", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.S3));
    const bytes = new Uint8Array([9]);
    mockFindMany.mockResolvedValue([
      {
        id: "att2",
        encryptedData: bytes,
        passwordEntryId: null,
        teamPasswordEntryId: "tpe1",
      },
    ]);

    const refs = await collectEntryAttachmentRefs(client, {
      kind: "team",
      teamId: "team1",
      entryIds: ["tpe1"],
    });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { teamPasswordEntryId: { in: ["tpe1"] } },
      select: {
        id: true,
        encryptedData: true,
        passwordEntryId: true,
        teamPasswordEntryId: true,
      },
    });
    expect(refs).toEqual([
      {
        stored: bytes,
        context: { attachmentId: "att2", entryId: "tpe1", teamId: "team1" },
      },
    ]);
  });
});

describe("collectAttachmentRefsByCreator", () => {
  it("returns [] without querying on the DB backend", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.DB));

    const refs = await collectAttachmentRefsByCreator(client, "user1");

    expect(refs).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("non-DB backend: queries by createdById; a team row's context names its entry and team", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.GCS));
    const personalBytes = new Uint8Array([1]);
    const teamBytes = new Uint8Array([2]);
    mockFindMany.mockResolvedValue([
      {
        id: "a-personal",
        encryptedData: personalBytes,
        passwordEntryId: "pe1",
        teamPasswordEntryId: null,
        teamPasswordEntry: null,
      },
      {
        id: "a-team",
        encryptedData: teamBytes,
        passwordEntryId: null,
        teamPasswordEntryId: "tpe1",
        teamPasswordEntry: { teamId: "team1" },
      },
    ]);

    const refs = await collectAttachmentRefsByCreator(client, "user1");

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { createdById: "user1" },
      select: {
        id: true,
        encryptedData: true,
        passwordEntryId: true,
        teamPasswordEntryId: true,
        teamPasswordEntry: { select: { teamId: true } },
      },
    });
    expect(refs).toEqual([
      {
        stored: personalBytes,
        context: { attachmentId: "a-personal", entryId: "pe1" },
      },
      {
        stored: teamBytes,
        context: { attachmentId: "a-team", entryId: "tpe1", teamId: "team1" },
      },
    ]);
  });
});

describe("deleteAttachmentBlobs", () => {
  it("is a no-op for an empty ref list", async () => {
    await deleteAttachmentBlobs([]);

    expect(mockGetAttachmentBlobStore).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("is a no-op on the DB backend (bytes, not refs; nothing logged)", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.DB));

    await deleteAttachmentBlobs([
      { stored: new Uint8Array([1, 2, 3]), context: { attachmentId: "a1", entryId: "e1" } },
    ]);

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("calls deleteObject once per ref with (stored, context)", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.S3));
    const refs: AttachmentBlobRef[] = [
      { stored: refBytes(`personal/e1/a1/${GEN}.bin`), context: { attachmentId: "a1", entryId: "e1" } },
      { stored: refBytes("personal/e2/a2.bin"), context: { attachmentId: "a2", entryId: "e2" } },
    ];

    await deleteAttachmentBlobs(refs);

    expect(mockDeleteObject).toHaveBeenCalledTimes(2);
    expect(mockDeleteObject).toHaveBeenNthCalledWith(1, refs[0].stored, refs[0].context);
    expect(mockDeleteObject).toHaveBeenNthCalledWith(2, refs[1].stored, refs[1].context);
  });

  it("swallows a storage failure and still attempts the other deletes (best-effort)", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.S3));
    mockDeleteObject
      .mockRejectedValueOnce(new Error("storage down"))
      .mockResolvedValueOnce(undefined);
    const refs: AttachmentBlobRef[] = [
      { stored: refBytes(`personal/e1/a1/${GEN}.bin`), context: { attachmentId: "a1", entryId: "e1" } },
      { stored: refBytes("personal/e2/a2.bin"), context: { attachmentId: "a2", entryId: "e2" } },
    ];

    await expect(deleteAttachmentBlobs(refs)).resolves.toBeUndefined();
    expect(mockDeleteObject).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an undecodable ref", new Uint8Array([1, 2, 3])],
    ["another row's ref", encodeObjectRef({ key: `personal/e1/other/${GEN}.bin` })],
  ])("skips and logs %s instead of deleting a guessed key", async (_label, stored) => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.S3));
    const good: AttachmentBlobRef = {
      stored: refBytes(`team/t1/e2/a2/${GEN}.bin`),
      context: { attachmentId: "a2", entryId: "e2", teamId: "t1" },
    };
    const bad: AttachmentBlobRef = { stored, context: { attachmentId: "a1", entryId: "e1" } };

    await deleteAttachmentBlobs([bad, good]);

    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteObject).toHaveBeenCalledWith(good.stored, good.context);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    // The log names the attachment, never the ref content.
    expect(mockWarn.mock.calls[0][0]).toEqual({ attachmentId: "a1" });
    expect(JSON.stringify(mockWarn.mock.calls[0])).not.toContain("personal/");
  });
});
