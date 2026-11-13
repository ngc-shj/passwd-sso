import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator } from "@/lib/translation-types";

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

const { mockSaveTeamEntry } = vi.hoisted(() => ({
  mockSaveTeamEntry: vi.fn(),
}));

vi.mock("@/lib/team/team-entry-save", () => ({
  saveTeamEntry: mockSaveTeamEntry,
}));

vi.mock("@/lib/crypto/crypto-team", () => ({
  generateItemKey: () => new Uint8Array(32),
  wrapItemKey: async () => ({ ciphertext: "ct", iv: "iv", authTag: "at" }),
  deriveItemEncryptionKey: async () => ({} as CryptoKey),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildItemKeyWrapAAD: () => new Uint8Array(0),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

import { executeTeamEntrySubmit } from "@/components/team/forms/team-entry-submit";

const dummyKey = {} as CryptoKey;

describe("executeTeamEntrySubmit", () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    mockSaveTeamEntry.mockReset();
    vi.restoreAllMocks();
  });

  it("submits create and handles success", async () => {
    const setSaving = vi.fn();
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();

    mockSaveTeamEntry.mockResolvedValue({ ok: true });

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: false,
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving,
      handleOpenChange,
      onSaved,
    });

    expect(setSaving).toHaveBeenCalledWith(true);
    expect(toastSuccessMock).toHaveBeenCalledWith("saved");
    expect(handleOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("create mode generates new ItemKey and passes encryptedItemKey", async () => {
    mockSaveTeamEntry.mockResolvedValue({ ok: true });

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: false,
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving: vi.fn(),
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    const call = mockSaveTeamEntry.mock.calls[0][0];
    expect(call.itemKeyVersion).toBe(1);
    expect(call.encryptedItemKey).toEqual({ ciphertext: "ct", iv: "iv", authTag: "at" });
    expect(call.entryId).toBeDefined();
    expect(call.mode).toBe("create");
  });

  it("edit v>=1 reuses existing ItemKey via getEntryDecryptionKey", async () => {
    const mockGetEntryDecryptionKey = vi.fn().mockResolvedValue(dummyKey);
    mockSaveTeamEntry.mockResolvedValue({ ok: true });

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: true,
      editData: {
        id: "entry-1",
        title: "x",
        username: "u",
        password: "p",
        url: null,
        notes: null,
        tags: [],
        itemKeyVersion: 1,
        teamKeyVersion: 1,
        encryptedItemKey: "ek-ct",
        itemKeyIv: "ek-iv",
        itemKeyAuthTag: "ek-at",
        itemKeyId: "ik-1",
      },
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving: vi.fn(),
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
      getEntryDecryptionKey: mockGetEntryDecryptionKey,
    });

    expect(mockGetEntryDecryptionKey).toHaveBeenCalledWith("team-1", "entry-1", {
      itemKeyVersion: 1,
      encryptedItemKey: "ek-ct",
      itemKeyIv: "ek-iv",
      itemKeyAuthTag: "ek-at",
      itemKeyId: "ik-1",
      teamKeyVersion: 1,
    });
    const call = mockSaveTeamEntry.mock.calls[0][0];
    expect(call.itemKeyVersion).toBe(1);
    // The ItemKey it reused, compared with the locked row (C1).
    expect(call.itemKeyId).toBe("ik-1");
    expect(call.encryptedItemKey).toBeUndefined(); // Keep existing in DB
    expect(call.mode).toBe("edit");
  });

  it("edit v0 upgrades at the server's nextItemKeyVersion and names the blob it replaces", async () => {
    mockSaveTeamEntry.mockResolvedValue({ ok: true });

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: true,
      editData: {
        id: "entry-1",
        title: "x",
        username: "u",
        password: "p",
        url: null,
        notes: null,
        tags: [],
        itemKeyVersion: 0,
        nextItemKeyVersion: 4,
        blobIv: "b-iv",
      },
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving: vi.fn(),
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    const call = mockSaveTeamEntry.mock.calls[0][0];
    expect(call.itemKeyVersion).toBe(4);
    expect(call.snapshotBlobIv).toBe("b-iv");
    expect(call.encryptedItemKey).toEqual({ ciphertext: "ct", iv: "iv", authTag: "at" });
    expect(call.entryId).toBe("entry-1");
    expect(call.mode).toBe("edit");
  });

  it("shows error when getEntryDecryptionKey is missing for v>=1 entry", async () => {
    const setSaving = vi.fn();

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: true,
      editData: {
        id: "entry-1",
        title: "x",
        username: "u",
        password: "p",
        url: null,
        notes: null,
        tags: [],
        itemKeyVersion: 1,
      },
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving,
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
      // getEntryDecryptionKey intentionally omitted
    });

    expect(toastErrorMock).toHaveBeenCalledWith("failedToSave");
    expect(setSaving).toHaveBeenLastCalledWith(false);
    expect(mockSaveTeamEntry).not.toHaveBeenCalled();
  });

  it("handles error and resets saving", async () => {
    const setSaving = vi.fn();

    mockSaveTeamEntry.mockResolvedValue(new Response(JSON.stringify({ error: "INTERNAL_ERROR" }), { status: 500 }));

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: true,
      editData: {
        id: "entry-1",
        title: "x",
        username: "u",
        password: "p",
        url: null,
        notes: null,
        tags: [],
      },
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving,
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    expect(toastErrorMock).toHaveBeenCalledWith("failedToSave");
    expect(setSaving).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ["ITEM_KEY_CHANGED", "teamEntryItemKeyChanged"],
    ["ITEM_KEY_VERSION_INVALID", "teamEntryItemKeyChanged"],
    ["ENTRY_REKEY_REQUIRED", "teamEntryRekeyRequired"],
    ["TEAM_KEY_VERSION_MISMATCH", "teamEntryTeamKeyChanged"],
    ["TEAM_BUSY", "teamEntryTeamBusy"],
  ])("maps a %s refusal to its own message", async (code, message) => {
    const setSaving = vi.fn();
    const onSaved = vi.fn();
    mockSaveTeamEntry.mockResolvedValue(new Response(JSON.stringify({ error: code }), { status: 409 }));

    await executeTeamEntrySubmit({
      teamId: "team-1",
      isEdit: true,
      editData: {
        id: "entry-1", title: "x", username: "u", password: "p", url: null, notes: null, tags: [],
        itemKeyVersion: 1, teamKeyVersion: 1, encryptedItemKey: "c", itemKeyIv: "i", itemKeyAuthTag: "a", itemKeyId: "ik-1",
      },
      teamEncryptionKey: dummyKey,
      teamKeyVersion: 2,
      fullBlob: "{}",
      overviewBlob: "{}",
      tagIds: [],
      t: mockTranslator<PasswordFormTranslator>(),
      setSaving,
      handleOpenChange: vi.fn(),
      onSaved,
      getEntryDecryptionKey: vi.fn().mockResolvedValue(dummyKey),
    });

    expect(toastErrorMock).toHaveBeenCalledWith(message);
    expect(onSaved).not.toHaveBeenCalled();
    expect(setSaving).toHaveBeenLastCalledWith(false);
  });
});
