import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLOB_STORAGE } from "./types";
import type { AttachmentBlobStore, BlobBackend } from "./types";
import {
  collectEntryAttachmentRefs,
  collectAttachmentRefsByCreator,
  deleteAttachmentBlobs,
  type AttachmentBlobRef,
} from "./cleanup";

const { mockGetAttachmentBlobStore } = vi.hoisted(() => ({
  mockGetAttachmentBlobStore: vi.fn(),
}));

vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: mockGetAttachmentBlobStore,
  BLOB_STORAGE,
}));

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

  it("non-DB backend: queries by createdById, entryId falls back to teamPasswordEntryId", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.GCS));
    const personalBytes = new Uint8Array([1]);
    const teamBytes = new Uint8Array([2]);
    mockFindMany.mockResolvedValue([
      {
        id: "a-personal",
        encryptedData: personalBytes,
        passwordEntryId: "pe1",
        teamPasswordEntryId: null,
      },
      {
        id: "a-team",
        encryptedData: teamBytes,
        passwordEntryId: null,
        teamPasswordEntryId: "tpe1",
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
      },
    });
    expect(refs).toEqual([
      {
        stored: personalBytes,
        context: { attachmentId: "a-personal", entryId: "pe1" },
      },
      {
        stored: teamBytes,
        context: { attachmentId: "a-team", entryId: "tpe1" },
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

  it("calls deleteObject once per ref with (stored, context)", async () => {
    mockGetAttachmentBlobStore.mockReturnValue(fakeStore(BLOB_STORAGE.S3));
    const refs: AttachmentBlobRef[] = [
      { stored: new Uint8Array([1]), context: { attachmentId: "a1", entryId: "e1" } },
      { stored: new Uint8Array([2]), context: { attachmentId: "a2", entryId: "e2" } },
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
      { stored: new Uint8Array([1]), context: { attachmentId: "a1", entryId: "e1" } },
      { stored: new Uint8Array([2]), context: { attachmentId: "a2", entryId: "e2" } },
    ];

    await expect(deleteAttachmentBlobs(refs)).resolves.toBeUndefined();
    expect(mockDeleteObject).toHaveBeenCalledTimes(2);
  });
});
