// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { API_PATH } from "@/lib/constants";

const { mockFetchApi, mockToast, searchState } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  searchState: { params: new URLSearchParams() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchState.params,
}));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { useShareLinks } from "./use-share-links";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const LINK = { id: "s1", isActive: true, revokedAt: null };

describe("useShareLinks", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockFetchApi.mockImplementation(async () => json({ items: [], nextCursor: null }));
    searchState.params = new URLSearchParams();
  });

  it("refetches with the status filter once it changes", async () => {
    const { result } = renderHook(() => useShareLinks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setStatusFilter("revoked"));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchApi).toHaveBeenLastCalledWith(`${API_PATH.SHARE_LINKS_MINE}?status=revoked`);
  });

  it("re-syncs the type filter when the type query parameter changes", async () => {
    searchState.params = new URLSearchParams("type=send");
    const { result, rerender } = renderHook(() => useShareLinks());
    expect(result.current.typeFilter).toBe("send");
    await waitFor(() => expect(result.current.loading).toBe(false));

    searchState.params = new URLSearchParams("type=other");
    rerender();

    expect(result.current.typeFilter).toBe("all");
  });

  it("does not load more without a cursor", async () => {
    const { result } = renderHook(() => useShareLinks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.handleLoadMore());

    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("marks only the revoked link inactive", async () => {
    mockFetchApi.mockResolvedValueOnce(json({ items: [LINK, { ...LINK, id: "s2" }], nextCursor: null }));
    const { result } = renderHook(() => useShareLinks());
    await waitFor(() => expect(result.current.links).toHaveLength(2));

    mockFetchApi.mockResolvedValueOnce(json({}));
    await act(() => result.current.handleRevoke("s1"));

    expect(result.current.links[0]).toMatchObject({ id: "s1", isActive: false });
    expect(result.current.links[0].revokedAt).toEqual(expect.any(String));
    expect(result.current.links[1]).toMatchObject({ id: "s2", isActive: true, revokedAt: null });
    expect(result.current.revokingId).toBeNull();
  });

  it("replaces the access logs when another link is expanded", async () => {
    const { result } = renderHook(() => useShareLinks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetchApi.mockResolvedValueOnce(json({ items: [{ id: "a" }], nextCursor: null }));
    act(() => result.current.toggleAccessLogs("s1"));
    await waitFor(() => expect(result.current.accessLogs).toEqual([{ id: "a" }]));

    mockFetchApi.mockResolvedValueOnce(json({ items: [{ id: "b" }], nextCursor: null }));
    act(() => result.current.toggleAccessLogs("s2"));
    await waitFor(() => expect(result.current.accessLogs).toEqual([{ id: "b" }]));
    expect(result.current.expandedLogId).toBe("s2");
  });

  it("leaves the access logs unchanged on a non-ok access-log response", async () => {
    const { result } = renderHook(() => useShareLinks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetchApi.mockResolvedValueOnce(json({}, 403));
    await act(() => result.current.fetchAccessLogs("s1"));

    expect(result.current.accessLogs).toEqual([]);
    expect(result.current.loadingLogs).toBe(false);
  });

  it("reloads the first page after a send is created", async () => {
    const { result } = renderHook(() => useShareLinks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetchApi.mockResolvedValueOnce(json({ items: [LINK], nextCursor: "n" }));
    act(() => result.current.handleSendCreated());

    await waitFor(() => expect(result.current.links).toEqual([LINK]));
    expect(result.current.nextCursor).toBe("n");
  });
});
