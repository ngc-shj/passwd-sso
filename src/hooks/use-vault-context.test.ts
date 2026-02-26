// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

let mockPathname = "/dashboard";
let mockSearch = "";
let mockLastContext = "personal";
const mockSetLastContext = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

vi.mock("@/hooks/use-local-storage", () => ({
  useLocalStorage: () => [mockLastContext, mockSetLastContext],
}));

import { useVaultContext } from "./use-vault-context";

describe("useVaultContext", () => {
  beforeEach(() => {
    mockPathname = "/dashboard";
    mockSearch = "";
    mockLastContext = "personal";
    mockSetLastContext.mockReset();
  });

  it("returns personal context on personal dashboard paths", () => {
    mockPathname = "/dashboard/favorites";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({ type: "personal" });
  });

  it("returns team context for org dashboard path", () => {
    mockPathname = "/dashboard/teams/team-1";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({
      type: "team",
      teamId: "team-1",
      teamName: "Security",
      teamRole: "ADMIN",
    });
  });

  it("uses last team context on cross-vault pages", () => {
    mockPathname = "/dashboard/watchtower";
    mockLastContext = "team-1";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({
      type: "team",
      teamId: "team-1",
      teamName: "Security",
      teamRole: "ADMIN",
    });
  });

  it("falls back to personal when last team context no longer exists", () => {
    mockPathname = "/dashboard/share-links";
    mockLastContext = "missing-team";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({ type: "personal" });
  });

  it("resolves team context from share-links team query", () => {
    mockPathname = "/dashboard/share-links";
    mockSearch = "team=team-1";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({
      type: "team",
      teamId: "team-1",
      teamName: "Security",
      teamRole: "ADMIN",
    });
  });

  it("falls back to personal for share-links with invalid team query", () => {
    mockPathname = "/dashboard/share-links";
    mockSearch = "team=invalid";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({ type: "personal" });
  });

  it("persists team context when visiting team page", () => {
    mockPathname = "/dashboard/teams/team-2";
    mockLastContext = "personal";

    renderHook(() =>
      useVaultContext([{ id: "team-2", name: "Team", role: "MEMBER" }])
    );

    expect(mockSetLastContext).toHaveBeenCalledWith("team-2");
  });

  it("persists personal context when returning to personal pages", () => {
    mockPathname = "/dashboard/archive";
    mockLastContext = "team-1";

    renderHook(() =>
      useVaultContext([{ id: "team-1", name: "Security", role: "ADMIN" }])
    );

    expect(mockSetLastContext).toHaveBeenCalledWith("personal");
  });
});
