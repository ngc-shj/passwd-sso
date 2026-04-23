import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockToastError, mockApiErrorToI18nKey } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockApiErrorToI18nKey: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));
vi.mock("@/lib/api-error-codes", () => ({
  apiErrorToI18nKey: mockApiErrorToI18nKey,
}));

import { showSidebarCrudError } from "./sidebar-crud-error";

describe("showSidebarCrudError", () => {
  const tErrors = vi.fn((key: string) => `translated:${key}`);

  beforeEach(() => {
    mockToastError.mockReset();
    mockApiErrorToI18nKey.mockReset();
    tErrors.mockClear();
  });

  it("shows translated error from API response", async () => {
    mockApiErrorToI18nKey.mockReturnValue("folderNameConflict");
    const res = new Response(JSON.stringify({ error: "FOLDER_NAME_CONFLICT" }), {
      status: 409,
    });

    await showSidebarCrudError(res, tErrors);

    expect(mockApiErrorToI18nKey).toHaveBeenCalledWith("FOLDER_NAME_CONFLICT");
    expect(tErrors).toHaveBeenCalledWith("folderNameConflict");
    expect(mockToastError).toHaveBeenCalledWith("translated:folderNameConflict");
  });

  it("shows unknownError when JSON parsing fails", async () => {
    const res = new Response("not json", { status: 500 });

    await showSidebarCrudError(res, tErrors);

    expect(tErrors).toHaveBeenCalledWith("unknownError");
    expect(mockToastError).toHaveBeenCalledWith("translated:unknownError");
  });
});
