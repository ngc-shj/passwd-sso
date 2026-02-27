// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSidebarData } from "./use-sidebar-data";

const teams = [{ id: "team-1", name: "Security", slug: "security", role: "ADMIN" }];
const tags = [{ id: "tag-1", name: "Critical", color: "red", passwordCount: 2 }];
const folders = [{ id: "folder-1", name: "Root", parentId: null, sortOrder: 0, entryCount: 3 }];
const teamTags = [{ id: "team-tag-1", name: "Ops", color: null, count: 1 }];
const teamFolders = [{ id: "team-folder-1", name: "Infra", parentId: null, sortOrder: 0, entryCount: 4 }];

function createFetchMock() {
  return vi.fn(async (url: string) => {
    if (url === "/api/tags") return { ok: true, json: async () => tags };
    if (url === "/api/folders") return { ok: true, json: async () => folders };
    if (url === "/api/teams") return { ok: true, json: async () => teams };
    if (url === "/api/teams/team-1/tags") return { ok: true, json: async () => teamTags };
    if (url === "/api/teams/team-1/folders") return { ok: true, json: async () => teamFolders };
    return { ok: false, json: async () => ({}) };
  });
}

describe("useSidebarData", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches tags/folders/team data on mount", async () => {
    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.tags).toHaveLength(1);
      expect(result.current.folders).toHaveLength(1);
      expect(result.current.teams).toHaveLength(1);
      expect(result.current.teamTagGroups).toHaveLength(1);
      expect(result.current.teamFolderGroups).toHaveLength(1);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/tags");
    expect(fetchMock).toHaveBeenCalledWith("/api/folders");
    expect(fetchMock).toHaveBeenCalledWith("/api/teams");
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team-1/tags");
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team-1/folders");
  });

  it("refreshes on vault-data-changed event", async () => {
    renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstCallCount = fetchMock.mock.calls.length;

    act(() => {
      window.dispatchEvent(new CustomEvent("vault-data-changed"));
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(firstCallCount);
    });
  });

  it("notifies via notifyDataChanged", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const initialCallCount = fetchMock.mock.calls.length;

    await act(async () => {
      result.current.notifyDataChanged();
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
  });

  it("re-fetches when pathname changes", async () => {
    const { rerender } = renderHook(({ path }) => useSidebarData(path), {
      initialProps: { path: "/dashboard" },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const firstCallCount = fetchMock.mock.calls.length;

    rerender({ path: "/dashboard/favorites" });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(firstCallCount);
    });
  });

  it("does not react to events after unmount", async () => {
    const { unmount } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const firstCallCount = fetchMock.mock.calls.length;

    unmount();

    act(() => {
      window.dispatchEvent(new CustomEvent("vault-data-changed"));
      window.dispatchEvent(new CustomEvent("team-data-changed"));
    });

    expect(fetchMock.mock.calls.length).toBe(firstCallCount);
  });

  it("keeps defaults when team fetch fails", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/tags") return { ok: true, json: async () => tags };
      if (url === "/api/folders") return { ok: true, json: async () => folders };
      if (url === "/api/teams") return { ok: false, json: async () => ({}) };
      return { ok: false, json: async () => ({}) };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.tags).toHaveLength(1);
      expect(result.current.folders).toHaveLength(1);
    });

    expect(result.current.teams).toEqual([]);
    expect(result.current.teamTagGroups).toEqual([]);
    expect(result.current.teamFolderGroups).toEqual([]);
    expect(result.current.lastError).toContain("/api/teams");
  });

  it("stores fetch error and clears it after successful refresh", async () => {
    let shouldFailTags = true;
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/tags") {
        if (shouldFailTags) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, json: async () => tags };
      }
      if (url === "/api/folders") return { ok: true, json: async () => folders };
      if (url === "/api/teams") return { ok: true, json: async () => [] };
      return { ok: false, status: 404, json: async () => ({}) };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.lastError).toContain("/api/tags");
    });

    shouldFailTags = false;
    act(() => {
      window.dispatchEvent(new CustomEvent("vault-data-changed"));
    });

    await waitFor(() => {
      expect(result.current.lastError).toBeNull();
      expect(result.current.tags).toHaveLength(1);
    });
  });

  it("includes team folder group for admin even with zero folders", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/tags") return { ok: true, json: async () => [] };
      if (url === "/api/folders") return { ok: true, json: async () => [] };
      if (url === "/api/teams") {
        return {
          ok: true,
          json: async () => [{ id: "team-1", name: "Security", slug: "security", role: "ADMIN" }],
        };
      }
      if (url === "/api/teams/team-1/tags") return { ok: true, json: async () => [] };
      if (url === "/api/teams/team-1/folders") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.teamFolderGroups).toHaveLength(1);
    });

    expect(result.current.teamFolderGroups[0]).toMatchObject({
      teamId: "team-1",
      teamRole: "ADMIN",
      folders: [],
    });
  });

  it("ignores stale responses from previous refresh", async () => {
    let resolveFirstTags: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | null = null;
    let tagCallCount = 0;

    fetchMock = vi.fn((url: string) => {
      if (url === "/api/tags") {
        tagCallCount += 1;
        if (tagCallCount === 1) {
          return new Promise((resolve) => {
            resolveFirstTags = resolve as typeof resolveFirstTags;
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "tag-new", name: "New", color: null, passwordCount: 1 }],
        });
      }
      if (url === "/api/folders") return Promise.resolve({ ok: true, json: async () => [] });
      if (url === "/api/teams") return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    }) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarData("/dashboard"));

    act(() => {
      window.dispatchEvent(new CustomEvent("vault-data-changed"));
    });

    await waitFor(() => {
      expect(result.current.tags).toEqual([
        { id: "tag-new", name: "New", color: null, passwordCount: 1 },
      ]);
    });

    await act(async () => {
      resolveFirstTags?.({
        ok: true,
        json: async () => [{ id: "tag-old", name: "Old", color: null, passwordCount: 9 }],
      });
      await Promise.resolve();
    });

    expect(result.current.tags).toEqual([
      { id: "tag-new", name: "New", color: null, passwordCount: 1 },
    ]);
  });
});
