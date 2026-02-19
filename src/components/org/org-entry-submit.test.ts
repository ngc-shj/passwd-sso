import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeOrgEntrySubmit } from "@/components/org/org-entry-submit";

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

describe("executeOrgEntrySubmit", () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    vi.restoreAllMocks();
  });

  it("submits create and handles success", async () => {
    const setSaving = vi.fn();
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await executeOrgEntrySubmit({
      orgId: "org-1",
      isEdit: false,
      body: { title: "A" },
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

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false })
    );

    await executeOrgEntrySubmit({
      orgId: "org-1",
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
      body: { title: "A" },
      t: (key) => key,
      setSaving,
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    expect(toastErrorMock).toHaveBeenCalledWith("failedToSave");
    expect(setSaving).toHaveBeenLastCalledWith(false);
  });
});
