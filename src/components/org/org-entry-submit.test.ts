import { beforeEach, describe, expect, it, vi } from "vitest";

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

const { mockSaveOrgEntry } = vi.hoisted(() => ({
  mockSaveOrgEntry: vi.fn(),
}));

vi.mock("@/lib/org-entry-save", () => ({
  saveOrgEntry: mockSaveOrgEntry,
}));

import { executeOrgEntrySubmit } from "@/components/org/org-entry-submit";

const dummyKey = {} as CryptoKey;

describe("executeOrgEntrySubmit", () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    mockSaveOrgEntry.mockReset();
    vi.restoreAllMocks();
  });

  it("submits create and handles success", async () => {
    const setSaving = vi.fn();
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();

    mockSaveOrgEntry.mockResolvedValue({ ok: true });

    await executeOrgEntrySubmit({
      teamId: "team-1",
      isEdit: false,
      orgEncryptionKey: dummyKey,
      orgKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: (key) => key,
      setSaving,
      handleOpenChange,
      onSaved,
    });

    expect(setSaving).toHaveBeenCalledWith(true);
    expect(toastSuccessMock).toHaveBeenCalledWith("saved");
    expect(handleOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("handles error and resets saving", async () => {
    const setSaving = vi.fn();

    mockSaveOrgEntry.mockResolvedValue({ ok: false });

    await executeOrgEntrySubmit({
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
      orgEncryptionKey: dummyKey,
      orgKeyVersion: 1,
      fullBlob: '{"title":"A"}',
      overviewBlob: '{"title":"A"}',
      tagIds: [],
      t: (key) => key,
      setSaving,
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    expect(toastErrorMock).toHaveBeenCalledWith("failedToSave");
    expect(setSaving).toHaveBeenLastCalledWith(false);
  });
});
