// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgAttachments } from "@/hooks/use-org-attachments";

describe("useOrgAttachments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch when entry id is missing", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const { result } = renderHook(() => useOrgAttachments(true, "org-1"));

    expect(result.current.attachments).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches attachments when open and entry id exists", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ id: "a1", filename: "f.txt", sizeBytes: 1, contentType: "text/plain", createdAt: "2026-01-01" }],
    } as Response);

    const { result } = renderHook(() => useOrgAttachments(true, "org-1", "entry-1"));

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1);
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/orgs/org-1/passwords/entry-1/attachments");
  });
});
