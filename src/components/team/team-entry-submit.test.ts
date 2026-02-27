import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/team-entry-save", () => ({
  saveTeamEntry: mockSaveTeamEntry,
}));

import { executeTeamEntrySubmit } from "@/components/team/team-entry-submit";

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

    mockSaveTeamEntry.mockResolvedValue({ ok: false });

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
      t: (key) => key,
      setSaving,
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    expect(toastErrorMock).toHaveBeenCalledWith("failedToSave");
    expect(setSaving).toHaveBeenLastCalledWith(false);
  });
});
