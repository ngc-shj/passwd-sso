import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { createE2EPasswordSchema } from "@/lib/validations";
import { createPersonalPasswordEntry } from "./personal-password-service";

type CreateInput = z.infer<typeof createE2EPasswordSchema>;

const mockFolderFindFirst = vi.fn();
const mockTagCount = vi.fn();
const mockPasswordEntryCreate = vi.fn();

const db = {
  folder: { findFirst: mockFolderFindFirst },
  tag: { count: mockTagCount },
  passwordEntry: { create: mockPasswordEntryCreate },
} as never;

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";

function baseInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    encryptedBlob: { ciphertext: "blob-ct", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "ov-ct", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 1,
    aadVersion: 1,
    entryType: "LOGIN",
    ...overrides,
  } as CreateInput;
}

beforeEach(() => {
  mockFolderFindFirst.mockReset();
  mockTagCount.mockReset();
  mockPasswordEntryCreate.mockReset();
  mockPasswordEntryCreate.mockResolvedValue({ id: "entry-1", tags: [] });
});

describe("createPersonalPasswordEntry", () => {
  it("returns FOLDER_NOT_FOUND when the folder is not owned by the caller", async () => {
    mockFolderFindFirst.mockResolvedValue(null);

    const result = await createPersonalPasswordEntry(
      db,
      USER_ID,
      TENANT_ID,
      baseInput({ folderId: "folder-x" }),
    );

    expect(result).toEqual({ ok: false, reason: "FOLDER_NOT_FOUND" });
    expect(mockFolderFindFirst).toHaveBeenCalledWith({
      where: { id: "folder-x", userId: USER_ID },
    });
    expect(mockPasswordEntryCreate).not.toHaveBeenCalled();
  });

  it("returns TAGS_NOT_OWNED when the owned tag count does not match the requested tags", async () => {
    mockTagCount.mockResolvedValue(1);

    const result = await createPersonalPasswordEntry(
      db,
      USER_ID,
      TENANT_ID,
      baseInput({ tagIds: ["tag-1", "tag-2"] }),
    );

    expect(result).toEqual({ ok: false, reason: "TAGS_NOT_OWNED" });
    expect(mockTagCount).toHaveBeenCalledWith({
      where: { id: { in: ["tag-1", "tag-2"] }, userId: USER_ID },
    });
    expect(mockPasswordEntryCreate).not.toHaveBeenCalled();
  });

  it("creates the entry with userId and tenantId on the happy path (no folder, no tags)", async () => {
    const created = { id: "entry-1", tags: [] };
    mockPasswordEntryCreate.mockResolvedValue(created);

    const result = await createPersonalPasswordEntry(db, USER_ID, TENANT_ID, baseInput());

    expect(result).toEqual({ ok: true, entry: created });
    expect(mockFolderFindFirst).not.toHaveBeenCalled();
    expect(mockTagCount).not.toHaveBeenCalled();
    expect(mockPasswordEntryCreate).toHaveBeenCalledTimes(1);
    const data = mockPasswordEntryCreate.mock.calls[0][0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.id).toBeUndefined();
    expect(data.tags).toBeUndefined();
  });

  it("uses the client-supplied id when present", async () => {
    const clientId = "11111111-1111-4111-8111-111111111111";

    await createPersonalPasswordEntry(
      db,
      USER_ID,
      TENANT_ID,
      baseInput({ id: clientId }),
    );

    const data = mockPasswordEntryCreate.mock.calls[0][0].data;
    expect(data.id).toBe(clientId);
  });

  it("connects owned tags when the tag count matches", async () => {
    mockTagCount.mockResolvedValue(2);

    const result = await createPersonalPasswordEntry(
      db,
      USER_ID,
      TENANT_ID,
      baseInput({ tagIds: ["tag-1", "tag-2"] }),
    );

    expect(result.ok).toBe(true);
    const data = mockPasswordEntryCreate.mock.calls[0][0].data;
    expect(data.tags).toEqual({
      connect: [{ id: "tag-1" }, { id: "tag-2" }],
    });
  });

  it("C3: succeeds when tagIds contain duplicates but are all owned (count mock returns 1 for [t1,t1])", async () => {
    // tag.count returns distinct row count; t1 is owned once → count=1.
    // Before the fix, ownedCount(1) !== tagIds.length(2) → TAGS_NOT_OWNED.
    // After the fix, ownedCount(1) !== uniqueTagIds.length(1) → success.
    mockTagCount.mockResolvedValue(1);

    const result = await createPersonalPasswordEntry(
      db,
      USER_ID,
      TENANT_ID,
      baseInput({ tagIds: ["t1", "t1"] }),
    );

    expect(result).toEqual({ ok: true, entry: expect.anything() });
    // The relation write must also dedupe — passing a duplicate connect to
    // Prisma is malformed input. Only the unique tag is connected.
    const data = mockPasswordEntryCreate.mock.calls[0][0].data;
    expect(data.tags).toEqual({ connect: [{ id: "t1" }] });
  });

  it("C3: still rejects when tagIds reference an unowned tag", async () => {
    // t1 owned, t2-unowned → count=1 but uniqueTagIds.length=2 → TAGS_NOT_OWNED
    mockTagCount.mockResolvedValue(1);

    const result = await createPersonalPasswordEntry(
      db,
      USER_ID,
      TENANT_ID,
      baseInput({ tagIds: ["t1", "t2-unowned"] }),
    );

    expect(result).toEqual({ ok: false, reason: "TAGS_NOT_OWNED" });
  });
});
