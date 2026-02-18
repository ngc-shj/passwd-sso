import { beforeEach, describe, expect, it, vi } from "vitest";
import { executePersonalEntrySubmit } from "@/components/passwords/personal-entry-submit";

const savePersonalEntryMock = vi.fn();
const handlePersonalSaveFeedbackMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/lib/personal-entry-save", () => ({
  savePersonalEntry: (...args: unknown[]) => savePersonalEntryMock(...args),
}));

vi.mock("@/components/passwords/personal-save-feedback", () => ({
  handlePersonalSaveFeedback: (...args: unknown[]) => handlePersonalSaveFeedbackMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

describe("executePersonalEntrySubmit", () => {
  beforeEach(() => {
    savePersonalEntryMock.mockReset();
    handlePersonalSaveFeedbackMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("handles success path", async () => {
    const setSubmitting = vi.fn();
    savePersonalEntryMock.mockResolvedValue({ ok: true });

    await executePersonalEntrySubmit({
      mode: "create",
      encryptionKey: {} as CryptoKey,
      fullBlob: "full",
      overviewBlob: "overview",
      tagIds: ["t1"],
      setSubmitting,
      t: (key) => key,
      router: { push: vi.fn(), refresh: vi.fn() },
    });

    expect(setSubmitting).toHaveBeenNthCalledWith(1, true);
    expect(handlePersonalSaveFeedbackMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(setSubmitting).toHaveBeenLastCalledWith(false);
  });

  it("handles failure path", async () => {
    const setSubmitting = vi.fn();
    savePersonalEntryMock.mockRejectedValue(new Error("network"));

    await executePersonalEntrySubmit({
      mode: "create",
      encryptionKey: {} as CryptoKey,
      fullBlob: "full",
      overviewBlob: "overview",
      tagIds: [],
      setSubmitting,
      t: (key) => key,
      router: { push: vi.fn(), refresh: vi.fn() },
    });

    expect(toastErrorMock).toHaveBeenCalledWith("networkError");
    expect(setSubmitting).toHaveBeenLastCalledWith(false);
  });
});
