// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSidebarData } from "./use-sidebar-data";

const orgs = [{ id: "org-1", name: "Security", slug: "security", role: "ADMIN" }];
const tags = [{ id: "tag-1", name: "Critical", color: "red", passwordCount: 2 }];
const folders = [{ id: "folder-1", name: "Root", parentId: null, sortOrder: 0, entryCount: 3 }];
const orgTags = [{ id: "org-tag-1", name: "Ops", color: null, count: 1 }];
const orgFolders = [{ id: "org-folder-1", name: "Infra", parentId: null, sortOrder: 0, entryCount: 4 }];

function createFetchMock() {
  return vi.fn(async (url: string) => {
    if (url === "/api/tags") return { ok: true, json: async () => tags };
    if (url === "/api/folders") return { ok: true, json: async () => folders };
    if (url === "/api/orgs") return { ok: true, json: async () => orgs };
    if (url === "/api/orgs/org-1/tags") return { ok: true, json: async () => orgTags };
    if (url === "/api/orgs/org-1/folders") return { ok: true, json: async () => orgFolders };
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

  it("fetches tags/folders/org data on mount", async () => {
    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.tags).toHaveLength(1);
      expect(result.current.folders).toHaveLength(1);
      expect(result.current.orgs).toHaveLength(1);
      expect(result.current.orgTagGroups).toHaveLength(1);
      expect(result.current.orgFolderGroups).toHaveLength(1);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/tags");
    expect(fetchMock).toHaveBeenCalledWith("/api/folders");
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs");
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/tags");
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/folders");
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
      window.dispatchEvent(new CustomEvent("org-data-changed"));
    });

    expect(fetchMock.mock.calls.length).toBe(firstCallCount);
  });

  it("keeps defaults when org fetch fails", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/tags") return { ok: true, json: async () => tags };
      if (url === "/api/folders") return { ok: true, json: async () => folders };
      if (url === "/api/orgs") return { ok: false, json: async () => ({}) };
      return { ok: false, json: async () => ({}) };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.tags).toHaveLength(1);
      expect(result.current.folders).toHaveLength(1);
    });

    expect(result.current.orgs).toEqual([]);
    expect(result.current.orgTagGroups).toEqual([]);
    expect(result.current.orgFolderGroups).toEqual([]);
    expect(result.current.lastError).toContain("/api/orgs");
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
      if (url === "/api/orgs") return { ok: true, json: async () => [] };
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

  it("includes org folder group for admin even with zero folders", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/tags") return { ok: true, json: async () => [] };
      if (url === "/api/folders") return { ok: true, json: async () => [] };
      if (url === "/api/orgs") {
        return {
          ok: true,
          json: async () => [{ id: "org-1", name: "Security", slug: "security", role: "ADMIN" }],
        };
      }
      if (url === "/api/orgs/org-1/tags") return { ok: true, json: async () => [] };
      if (url === "/api/orgs/org-1/folders") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarData("/dashboard"));

    await waitFor(() => {
      expect(result.current.orgFolderGroups).toHaveLength(1);
    });

    expect(result.current.orgFolderGroups[0]).toMatchObject({
      orgId: "org-1",
      orgRole: "ADMIN",
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
      if (url === "/api/orgs") return Promise.resolve({ ok: true, json: async () => [] });
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
