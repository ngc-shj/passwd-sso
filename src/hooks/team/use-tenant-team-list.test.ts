// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { API_PATH } from "@/lib/constants";
import { TEAM_DATA_CHANGED_EVENT } from "@/lib/events";

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));

vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { useTenantTeamList } from "./use-tenant-team-list";

const TEAM = {
  id: "team-1",
  name: "Platform",
  slug: "platform",
  description: null,
  role: "OWNER",
  createdAt: "2026-01-02T00:00:00.000Z",
  memberCount: 3,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("useTenantTeamList", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("loads the teams from the teams endpoint", async () => {
    mockFetchApi.mockImplementation(async () => json([TEAM]));
    const { result } = renderHook(() => useTenantTeamList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teams).toEqual([TEAM]);
    expect(mockFetchApi).toHaveBeenCalledWith(API_PATH.TEAMS);
  });

  it("starts in the loading state", () => {
    mockFetchApi.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTenantTeamList());

    expect(result.current.loading).toBe(true);
  });

  it("leaves the list empty and stops loading on a non-ok response", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "FORBIDDEN" }, 403));
    const { result } = renderHook(() => useTenantTeamList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teams).toEqual([]);
  });

  it("stops loading when the request rejects", async () => {
    mockFetchApi.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTenantTeamList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teams).toEqual([]);
  });

  it("handleCreated refetches and dispatches the team-data-changed event", async () => {
    mockFetchApi.mockResolvedValueOnce(json([]));
    const { result } = renderHook(() => useTenantTeamList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const listener = vi.fn();
    window.addEventListener(TEAM_DATA_CHANGED_EVENT, listener);
    mockFetchApi.mockResolvedValueOnce(json([TEAM]));
    act(() => result.current.handleCreated());

    expect(listener).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.teams).toEqual([TEAM]));
    expect(mockFetchApi).toHaveBeenCalledTimes(2);
    window.removeEventListener(TEAM_DATA_CHANGED_EVENT, listener);
  });
});
