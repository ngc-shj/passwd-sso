// @vitest-environment jsdom
"use client";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePersonalTags } from "./use-personal-tags";

vi.mock("@/lib/constants", () => ({
  API_PATH: { TAGS: "/api/tags" },
}));

describe("usePersonalTags", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and returns tags on mount", async () => {
    const data = [
      { id: "t1", name: "work", color: "#ff0000", passwordCount: 3 },
      { id: "t2", name: "personal", color: null, passwordCount: 1 },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    );

    const { result } = renderHook(() => usePersonalTags());

    await waitFor(() => {
      expect(result.current.tags).toHaveLength(2);
    });
    expect(result.current.tags[0].name).toBe("work");
    expect(result.current.fetchError).toBeNull();
  });

  it("sets fetchError when API returns non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const { result } = renderHook(() => usePersonalTags());

    await waitFor(() => {
      expect(result.current.fetchError).toContain("404");
    });
    expect(result.current.tags).toEqual([]);
  });

  it("returns empty array when API returns non-array data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad" }), { status: 200 }),
    );

    const { result } = renderHook(() => usePersonalTags());

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    // Non-array response doesn't set tags or error — just ignores silently
    expect(result.current.tags).toEqual([]);
  });

  it("sets fetchError on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => usePersonalTags());

    await waitFor(() => {
      expect(result.current.fetchError).toContain("network error");
    });
    expect(result.current.tags).toEqual([]);
  });
});
