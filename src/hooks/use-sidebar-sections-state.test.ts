// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockSetCollapsed = vi.fn();
const mockCollapsed = {
  categories: true,
  manage: true,
  security: true,
  settingsNav: true,
  tools: true,
};

vi.mock("@/hooks/use-local-storage", () => ({
  useLocalStorage: () => [mockCollapsed, mockSetCollapsed],
}));

import { useSidebarSectionsState } from "./use-sidebar-sections-state";

function baseParams() {
  return {
    routeKey: "/dashboard",
    selectedTypeFilter: null,
    selectedTagId: null,
    selectedFolderId: null,
    isWatchtower: false,
    isShareLinks: false,
    isEmergencyAccess: false,
    isAuditLog: false,
    isSettingsActive: false,
    isExportActive: false,
    isImportActive: false,
    isAdminActive: false,
  };
}

describe("useSidebarSectionsState", () => {
  beforeEach(() => {
    mockSetCollapsed.mockReset();
  });

  it("inverts collapsed state through isOpen", () => {
    const { result } = renderHook(() => useSidebarSectionsState(baseParams()));
    expect(result.current.isOpen("settingsNav")).toBe(false);
  });

  it("toggles section state", () => {
    const { result } = renderHook(() => useSidebarSectionsState(baseParams()));

    act(() => {
      result.current.toggleSection("categories")(true);
    });

    expect(mockSetCollapsed).toHaveBeenCalled();
  });

  it("auto-opens matching sections on route state", () => {
    renderHook(() =>
      useSidebarSectionsState({
        ...baseParams(),
        routeKey: "/dashboard?type=LOGIN&tag=t1",
        selectedTypeFilter: "LOGIN",
        selectedTagId: "t1",
        isWatchtower: true,
      }),
    );

    const updater = mockSetCollapsed.mock.calls[0][0] as (prev: typeof mockCollapsed) => typeof mockCollapsed;
    const next = updater(mockCollapsed);

    expect(next.categories).toBe(false);
    expect(next.manage).toBe(false);
    expect(next.security).toBe(false);
  });

  it("does not auto-open settings section when isAdminActive is true", () => {
    renderHook(() =>
      useSidebarSectionsState({
        ...baseParams(),
        routeKey: "/admin/tenant/members",
        isSettingsActive: true,
        isAdminActive: true,
      }),
    );

    // isAdminActive prevents settings section from auto-opening,
    // so setCollapsed should not be called at all (toOpen is empty)
    expect(mockSetCollapsed).not.toHaveBeenCalled();
  });
});
