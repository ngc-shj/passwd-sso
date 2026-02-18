import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";

const buildPasswordHistoryMock = vi.fn();
const buildPersonalEntryPayloadMock = vi.fn();
const savePersonalEntryMock = vi.fn();
const handlePersonalSaveFeedbackMock = vi.fn();
const extractTagIdsMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/lib/personal-entry-payload", () => ({
  buildPasswordHistory: (...args: unknown[]) => buildPasswordHistoryMock(...args),
  buildPersonalEntryPayload: (...args: unknown[]) => buildPersonalEntryPayloadMock(...args),
}));

vi.mock("@/lib/personal-entry-save", () => ({
  savePersonalEntry: (...args: unknown[]) => savePersonalEntryMock(...args),
}));

vi.mock("@/components/passwords/personal-save-feedback", () => ({
  handlePersonalSaveFeedback: (...args: unknown[]) => handlePersonalSaveFeedbackMock(...args),
}));

vi.mock("@/lib/entry-form-helpers", () => ({
  extractTagIds: (...args: unknown[]) => extractTagIdsMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

describe("submitPersonalPasswordForm", () => {
  beforeEach(() => {
    buildPasswordHistoryMock.mockReset();
    buildPersonalEntryPayloadMock.mockReset();
    savePersonalEntryMock.mockReset();
    handlePersonalSaveFeedbackMock.mockReset();
    extractTagIdsMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("returns early when encryption key is missing", async () => {
    const setSubmitting = vi.fn();

    await submitPersonalPasswordForm({
      mode: "create",
      encryptionKey: null,
      title: "title",
      username: "",
      password: "pw",
      url: "",
      notes: "",
      selectedTags: [],
      generatorSettings: DEFAULT_GENERATOR_SETTINGS,
      customFields: [],
      totp: null,
      requireReprompt: false,
      folderId: null,
      setSubmitting,
      t: (key) => key,
      router: {},
    });

    expect(setSubmitting).not.toHaveBeenCalled();
    expect(savePersonalEntryMock).not.toHaveBeenCalled();
  });

  it("submits and handles success feedback", async () => {
    const setSubmitting = vi.fn();
    const encryptionKey = {} as CryptoKey;
    const selectedTags = [{ id: "t1", name: "tag", color: "#fff" }];

    buildPasswordHistoryMock.mockReturnValue([]);
    buildPersonalEntryPayloadMock.mockReturnValue({
      fullBlob: { encryptedData: "full" },
      overviewBlob: { encryptedData: "overview" },
    });
    extractTagIdsMock.mockReturnValue(["t1"]);
    savePersonalEntryMock.mockResolvedValue({ ok: true });

    await submitPersonalPasswordForm({
      mode: "create",
      encryptionKey,
      userId: "user-1",
      title: "title",
      username: "user",
      password: "pw",
      url: "https://example.com",
      notes: "notes",
      selectedTags,
      generatorSettings: DEFAULT_GENERATOR_SETTINGS,
      customFields: [],
      totp: null,
      requireReprompt: true,
      folderId: "folder-1",
      setSubmitting,
      t: (key) => key,
      router: { push: vi.fn() },
    });

    expect(setSubmitting).toHaveBeenNthCalledWith(1, true);
    expect(savePersonalEntryMock).toHaveBeenCalledTimes(1);
    expect(handlePersonalSaveFeedbackMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(setSubmitting).toHaveBeenLastCalledWith(false);
  });

  it("shows network error toast on failure", async () => {
    const setSubmitting = vi.fn();
    const encryptionKey = {} as CryptoKey;

    buildPasswordHistoryMock.mockReturnValue([]);
    buildPersonalEntryPayloadMock.mockReturnValue({
      fullBlob: { encryptedData: "full" },
      overviewBlob: { encryptedData: "overview" },
    });
    extractTagIdsMock.mockReturnValue([]);
    savePersonalEntryMock.mockRejectedValue(new Error("network"));

    await submitPersonalPasswordForm({
      mode: "create",
      encryptionKey,
      title: "title",
      username: "user",
      password: "pw",
      url: "",
      notes: "",
      selectedTags: [],
      generatorSettings: DEFAULT_GENERATOR_SETTINGS,
      customFields: [],
      totp: null,
      requireReprompt: false,
      folderId: null,
      setSubmitting,
      t: (key) => key,
      router: {},
    });

    expect(toastErrorMock).toHaveBeenCalledWith("networkError");
    expect(setSubmitting).toHaveBeenLastCalledWith(false);
  });
});
