// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const { mockFetchApi, mockToast } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { useTeamProfileForm } from "./use-team-profile-form";

const TEAM = { id: "t1", name: "Platform", slug: "platform", description: "Ops", role: "OWNER" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("useTeamProfileForm", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("loads the team and seeds name and description", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    const { result } = renderHook(() => useTeamProfileForm("t1"));

    await waitFor(() => expect(result.current.team).toEqual(TEAM));
    expect(result.current.name).toBe("Platform");
    expect(result.current.description).toBe("Ops");
    expect(result.current.hasChanges).toBe(false);
  });

  it("treats OWNER and ADMIN as admins", async () => {
    mockFetchApi.mockImplementation(async () => json({ ...TEAM, role: "ADMIN" }));
    const { result } = renderHook(() => useTeamProfileForm("t1"));

    await waitFor(() => expect(result.current.team).not.toBeNull());
    expect(result.current.isAdmin).toBe(true);
  });

  it("does not treat a VIEWER as an admin", async () => {
    mockFetchApi.mockImplementation(async () => json({ ...TEAM, role: "VIEWER" }));
    const { result } = renderHook(() => useTeamProfileForm("t1"));

    await waitFor(() => expect(result.current.team).not.toBeNull());
    expect(result.current.isAdmin).toBe(false);
  });

  it("flags a load error when the request rejects", async () => {
    mockFetchApi.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTeamProfileForm("t1"));

    await waitFor(() => expect(result.current.loadError).toBe(true));
    expect(result.current.team).toBeNull();
  });

  it("resets the team and refetches when the team id changes", async () => {
    mockFetchApi.mockResolvedValueOnce(json(TEAM));
    const { result, rerender } = renderHook(({ id }) => useTeamProfileForm(id), {
      initialProps: { id: "t1" },
    });
    await waitFor(() => expect(result.current.team).not.toBeNull());

    mockFetchApi.mockReturnValueOnce(new Promise(() => {}));
    rerender({ id: "t2" });

    expect(result.current.team).toBeNull();
    expect(mockFetchApi).toHaveBeenLastCalledWith("/api/teams/t2");
  });

  it("does not save a whitespace-only name", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    const { result } = renderHook(() => useTeamProfileForm("t1"));
    await waitFor(() => expect(result.current.team).not.toBeNull());
    act(() => result.current.setName("  "));

    await act(() => result.current.handleUpdateTeam());

    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("marks the form clean again after a successful save", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    const { result } = renderHook(() => useTeamProfileForm("t1"));
    await waitFor(() => expect(result.current.team).not.toBeNull());
    act(() => result.current.setDescription("Changed"));
    expect(result.current.hasChanges).toBe(true);

    mockFetchApi.mockResolvedValueOnce(json({})).mockImplementation(async () => json({ ...TEAM, description: "Changed" }));
    await act(() => result.current.handleUpdateTeam());

    expect(mockToast.success).toHaveBeenCalledWith("updated");
    await waitFor(() => expect(result.current.hasChanges).toBe(false));
    expect(result.current.saving).toBe(false);
  });

  it("keeps the form dirty after a 400 response", async () => {
    mockFetchApi.mockResolvedValueOnce(json(TEAM)).mockResolvedValueOnce(json({}, 400));
    const { result } = renderHook(() => useTeamProfileForm("t1"));
    await waitFor(() => expect(result.current.team).not.toBeNull());
    act(() => result.current.setName("Renamed"));

    await act(() => result.current.handleUpdateTeam());

    expect(mockToast.error).toHaveBeenCalledWith("validationError");
    expect(result.current.hasChanges).toBe(true);
    expect(result.current.saving).toBe(false);
  });
});
