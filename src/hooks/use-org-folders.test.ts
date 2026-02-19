// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgFolders } from "@/hooks/use-org-folders";

describe("useOrgFolders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch when dialog is closed", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const { result } = renderHook(() => useOrgFolders(false, "org-1"));

    expect(result.current.folders).toEqual([]);
    expect(result.current.fetchError).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches folders when open", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ id: "f1", name: "Work", parentId: null }],
    } as Response);

    const { result } = renderHook(() => useOrgFolders(true, "org-1"));

    await waitFor(() => {
      expect(result.current.folders).toEqual([{ id: "f1", name: "Work", parentId: null }]);
    });
    expect(result.current.fetchError).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/orgs/org-1/folders");
  });

  it("sets fetchError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const { result } = renderHook(() => useOrgFolders(true, "org-1"));

    await waitFor(() => {
      expect(result.current.fetchError).toContain("500");
    });
    expect(result.current.folders).toEqual([]);
  });

  it("sets fetchError on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => useOrgFolders(true, "org-1"));

    await waitFor(() => {
      expect(result.current.fetchError).toContain("network error");
    });
    expect(result.current.folders).toEqual([]);
  });
});
