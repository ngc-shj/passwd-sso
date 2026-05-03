// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(),
}));

import { useTeamPolicy } from "@/hooks/team/use-team-policy";
import { fetchApi } from "@/lib/url-helpers";

const fetchApiMock = vi.mocked(fetchApi);

const DEFAULT_POLICY = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

const SERVER_POLICY = {
  minPasswordLength: 16,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: true,
  requireRepromptForAll: true,
  allowExport: false,
  allowSharing: false,
  requireSharePassword: true,
  passwordHistoryCount: 5,
  inheritTenantCidrs: false,
  teamAllowedCidrs: ["10.0.0.0/8"],
};

function mockOk<T>(body: T): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockNotOk(status = 403): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

describe("useTeamPolicy", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it("does not fetch when open=false and keeps default policy", () => {
    const { result } = renderHook(() => useTeamPolicy(false, "team-1"));

    expect(fetchApiMock).not.toHaveBeenCalled();
    expect(result.current.policy).toEqual(DEFAULT_POLICY);
  });

  it("fetches the team policy URL when open becomes true", async () => {
    fetchApiMock.mockResolvedValueOnce(mockOk(SERVER_POLICY));

    const { result } = renderHook(
      ({ open }: { open: boolean }) => useTeamPolicy(open, "team-42"),
      { initialProps: { open: true } },
    );

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });

    const calledUrl = fetchApiMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/teams/team-42/policy");

    await waitFor(() => {
      expect(result.current.policy).toEqual(SERVER_POLICY);
    });
  });

  it("falls back to default policy on non-ok response", async () => {
    fetchApiMock.mockResolvedValueOnce(mockNotOk(403));

    const { result } = renderHook(() => useTeamPolicy(true, "team-1"));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });

    // Allow the .then() chain to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.policy).toEqual(DEFAULT_POLICY);
  });

  it("falls back to default policy when fetchApi rejects", async () => {
    fetchApiMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useTeamPolicy(true, "team-1"));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.policy).toEqual(DEFAULT_POLICY);
  });

  it("re-fetches when teamId changes while open", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockOk(SERVER_POLICY))
      .mockResolvedValueOnce(mockOk({ ...SERVER_POLICY, minPasswordLength: 24 }));

    const { rerender } = renderHook(
      ({ teamId }: { teamId: string }) => useTeamPolicy(true, teamId),
      { initialProps: { teamId: "team-1" } },
    );

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });

    rerender({ teamId: "team-2" });

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(2);
    });

    const second = fetchApiMock.mock.calls[1][0] as string;
    expect(second).toContain("/teams/team-2/policy");
  });
});
