import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";

const buildPasswordHistoryMock = vi.fn();
const buildPersonalEntryPayloadMock = vi.fn();
const extractTagIdsMock = vi.fn();
const executePersonalEntrySubmitMock = vi.fn();

vi.mock("@/lib/personal-entry-payload", () => ({
  buildPasswordHistory: (...args: unknown[]) => buildPasswordHistoryMock(...args),
  buildPersonalEntryPayload: (...args: unknown[]) => buildPersonalEntryPayloadMock(...args),
}));

vi.mock("@/lib/entry-form-helpers", () => ({
  extractTagIds: (...args: unknown[]) => extractTagIdsMock(...args),
}));

vi.mock("@/components/passwords/personal-entry-submit", () => ({
  executePersonalEntrySubmit: (...args: unknown[]) => executePersonalEntrySubmitMock(...args),
}));

describe("submitPersonalPasswordForm", () => {
  beforeEach(() => {
    buildPasswordHistoryMock.mockReset();
    buildPersonalEntryPayloadMock.mockReset();
    extractTagIdsMock.mockReset();
    executePersonalEntrySubmitMock.mockReset();
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
      router: { push: vi.fn(), refresh: vi.fn() },
    });

    expect(setSubmitting).not.toHaveBeenCalled();
    expect(executePersonalEntrySubmitMock).not.toHaveBeenCalled();
  });

  it("builds payload and delegates to executePersonalEntrySubmit", async () => {
    const setSubmitting = vi.fn();
    const encryptionKey = {} as CryptoKey;
    const selectedTags = [{ id: "t1", name: "tag", color: "#fff" }];

    buildPasswordHistoryMock.mockReturnValue([{ password: "old", changedAt: "time" }]);
    buildPersonalEntryPayloadMock.mockReturnValue({
      fullBlob: "full",
      overviewBlob: "overview",
    });
    extractTagIdsMock.mockReturnValue(["t1"]);

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
      router: { push: vi.fn(), refresh: vi.fn() },
    });

    expect(buildPasswordHistoryMock).toHaveBeenCalledTimes(1);
    expect(buildPersonalEntryPayloadMock).toHaveBeenCalledTimes(1);
    expect(extractTagIdsMock).toHaveBeenCalledWith(selectedTags);
    expect(executePersonalEntrySubmitMock).toHaveBeenCalledTimes(1);
    expect(executePersonalEntrySubmitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "create",
        encryptionKey,
        fullBlob: "full",
        overviewBlob: "overview",
        tagIds: ["t1"],
        requireReprompt: true,
        folderId: "folder-1",
      }),
    );
  });
});
