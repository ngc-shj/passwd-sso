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
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({ type: "personal" });
  });

  it("returns org context for org dashboard path", () => {
    mockPathname = "/dashboard/teams/org-1";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({
      type: "org",
      orgId: "org-1",
      orgName: "Security",
      orgRole: "ADMIN",
    });
  });

  it("uses last org context on cross-vault pages", () => {
    mockPathname = "/dashboard/watchtower";
    mockLastContext = "org-1";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({
      type: "org",
      orgId: "org-1",
      orgName: "Security",
      orgRole: "ADMIN",
    });
  });

  it("falls back to personal when last org context no longer exists", () => {
    mockPathname = "/dashboard/share-links";
    mockLastContext = "missing-org";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({ type: "personal" });
  });

  it("resolves org context from share-links org query", () => {
    mockPathname = "/dashboard/share-links";
    mockSearch = "org=org-1";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({
      type: "org",
      orgId: "org-1",
      orgName: "Security",
      orgRole: "ADMIN",
    });
  });

  it("falls back to personal for share-links with invalid org query", () => {
    mockPathname = "/dashboard/share-links";
    mockSearch = "org=invalid";

    const { result } = renderHook(() =>
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(result.current).toEqual({ type: "personal" });
  });

  it("persists org context when visiting org page", () => {
    mockPathname = "/dashboard/teams/org-2";
    mockLastContext = "personal";

    renderHook(() =>
      useVaultContext([{ id: "org-2", name: "Team", role: "MEMBER" }])
    );

    expect(mockSetLastContext).toHaveBeenCalledWith("org-2");
  });

  it("persists personal context when returning to personal pages", () => {
    mockPathname = "/dashboard/archive";
    mockLastContext = "org-1";

    renderHook(() =>
      useVaultContext([{ id: "org-1", name: "Security", role: "ADMIN" }])
    );

    expect(mockSetLastContext).toHaveBeenCalledWith("personal");
  });
});
