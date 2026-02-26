// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { mockToastError, mockApiErrorToI18nKey } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockApiErrorToI18nKey: vi.fn((code: unknown) => (typeof code === "string" ? code : "unknownError")),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

vi.mock("@/lib/api-error-codes", () => ({
  apiErrorToI18nKey: mockApiErrorToI18nKey,
}));

import { useSidebarTagCrud } from "./use-sidebar-tag-crud";

describe("useSidebarTagCrud", () => {
  const refreshData = vi.fn();
  const tErrors = vi.fn((k: string) => k);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits personal tag update to /api/tags/:id and refreshes", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;

    const { result } = renderHook(() => useSidebarTagCrud({ refreshData, tErrors }));

    act(() => {
      result.current.handleTagEdit({ id: "tag-1", name: "Old", color: null });
    });

    await act(async () => {
      await result.current.handleTagSubmit({ name: "New", color: "#123456" });
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tags/tag-1",
      expect.objectContaining({ method: "PUT" })
    );
    expect(refreshData).toHaveBeenCalledTimes(1);
  });

  it("submits org tag update to /api/teams/:orgId/tags/:id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;

    const { result } = renderHook(() => useSidebarTagCrud({ refreshData, tErrors }));

    act(() => {
      result.current.handleTagEdit({ id: "tag-1", name: "Old", color: null }, "org-1");
    });

    await act(async () => {
      await result.current.handleTagSubmit({ name: "New", color: "#123456" });
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/teams/org-1/tags/tag-1",
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("submits personal tag creation via POST to /api/tags", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;

    const { result } = renderHook(() => useSidebarTagCrud({ refreshData, tErrors }));

    act(() => {
      result.current.handleTagCreate();
    });

    expect(result.current.tagDialogOpen).toBe(true);
    expect(result.current.editingTag).toBeNull();

    await act(async () => {
      await result.current.handleTagSubmit({ name: "New Tag", color: "#ff0000" });
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tags",
      expect.objectContaining({ method: "POST" })
    );
    expect(refreshData).toHaveBeenCalledTimes(1);
  });

  it("submits org tag creation via POST to /api/teams/:orgId/tags", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;

    const { result } = renderHook(() => useSidebarTagCrud({ refreshData, tErrors }));

    act(() => {
      result.current.handleTagCreate("org-1");
    });

    await act(async () => {
      await result.current.handleTagSubmit({ name: "Org Tag", color: "#00ff00" });
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/teams/org-1/tags",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows translated error and throws on submit failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "TAG_ALREADY_EXISTS" }),
    }) as never;

    const { result } = renderHook(() => useSidebarTagCrud({ refreshData, tErrors }));

    act(() => {
      result.current.handleTagEdit({ id: "tag-1", name: "Old", color: null });
    });

    await expect(
      result.current.handleTagSubmit({ name: "Dup", color: null })
    ).rejects.toThrow("API error");

    expect(mockToastError).toHaveBeenCalledWith("TAG_ALREADY_EXISTS");
    expect(refreshData).not.toHaveBeenCalled();
  });

  it("clears deletingTag on delete failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "FORBIDDEN" }),
    }) as never;

    const { result } = renderHook(() => useSidebarTagCrud({ refreshData, tErrors }));

    act(() => {
      result.current.handleTagDeleteClick({ id: "tag-1", name: "X", color: null });
    });

    await act(async () => {
      await result.current.handleTagDelete();
    });

    expect(result.current.deletingTag).toBeNull();
    expect(mockToastError).toHaveBeenCalledWith("FORBIDDEN");
    expect(refreshData).not.toHaveBeenCalled();
  });
});
