// @vitest-environment jsdom
"use client";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePersonalFolders } from "./use-personal-folders";

vi.mock("@/lib/constants", () => ({
  API_PATH: { FOLDERS: "/api/folders" },
}));

describe("usePersonalFolders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and returns folders on mount", async () => {
    const data = [
      { id: "f1", name: "Work", parentId: null },
      { id: "f2", name: "Personal", parentId: null },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    );

    const { result } = renderHook(() => usePersonalFolders());

    await waitFor(() => {
      expect(result.current.folders).toHaveLength(2);
    });
    expect(result.current.folders[0].name).toBe("Work");
    expect(result.current.fetchError).toBeNull();
  });

  it("sets fetchError when API returns non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const { result } = renderHook(() => usePersonalFolders());

    await waitFor(() => {
      expect(result.current.fetchError).toContain("404");
    });
    expect(result.current.folders).toEqual([]);
  });

  it("returns empty array when API returns non-array data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad" }), { status: 200 }),
    );

    const { result } = renderHook(() => usePersonalFolders());

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    // Non-array response doesn't set folders or error — just ignores silently
    expect(result.current.folders).toEqual([]);
  });

  it("sets fetchError on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => usePersonalFolders());

    await waitFor(() => {
      expect(result.current.fetchError).toContain("network error");
    });
    expect(result.current.folders).toEqual([]);
  });
});
