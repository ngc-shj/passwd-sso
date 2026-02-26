// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSidebarViewModel } from "./use-sidebar-view-model";

function makeParams() {
  return {
    t: (k: string) => k,
    tTeam: (k: string) => k,
    router: { push: vi.fn() },
    onOpenChange: vi.fn(),
    vaultContext: { type: "personal" as const },
    teams: [{ id: "team-1", name: "Acme", slug: "acme", role: "ADMIN" }],
    selectedTeam: null,
    selectedTeamCanManageFolders: false,
    selectedTeamCanManageTags: false,
    selectedTypeFilter: null,
    selectedFolderId: null,
    selectedTagId: null,
    isSelectedVaultAll: true,
    isSelectedVaultFavorites: false,
    isSelectedVaultArchive: false,
    isSelectedVaultTrash: false,
    isWatchtower: false,
    isShareLinks: false,
    isEmergencyAccess: false,
    isPersonalAuditLog: false,
    activeAuditTeamId: null,
    selectedFolders: [],
    selectedTags: [],
    isOpen: vi.fn(() => true),
    toggleSection: vi.fn(() => vi.fn()),
    handleFolderCreate: vi.fn(),
    handleFolderEdit: vi.fn(),
    handleFolderDeleteClick: vi.fn(),
    handleTagCreate: vi.fn(),
    handleTagEdit: vi.fn(),
    handleTagDeleteClick: vi.fn(),
  };
}

describe("useSidebarViewModel", () => {
  it("navigates to personal vault and closes sidebar", () => {
    const params = makeParams();
    const { result } = renderHook(() => useSidebarViewModel(params));

    act(() => {
      result.current.onVaultChange("personal");
    });

    expect(params.router.push).toHaveBeenCalledWith("/dashboard");
    expect(params.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("navigates to team vault and closes sidebar", () => {
    const params = makeParams();
    const { result } = renderHook(() => useSidebarViewModel(params));

    act(() => {
      result.current.onVaultChange("team-1");
    });

    expect(params.router.push).toHaveBeenCalledWith("/dashboard/teams/team-1");
    expect(params.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("exposes onNavigate behavior", () => {
    const params = makeParams();
    const { result } = renderHook(() => useSidebarViewModel(params));

    act(() => {
      result.current.onNavigate();
    });

    expect(params.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("forwards sidebar state and handlers", () => {
    const params = makeParams();
    const { result } = renderHook(() => useSidebarViewModel(params));

    // Handlers (renamed props)
    expect(result.current.onCreateFolder).toBe(params.handleFolderCreate);
    expect(result.current.onEditFolder).toBe(params.handleFolderEdit);
    expect(result.current.onDeleteFolder).toBe(params.handleFolderDeleteClick);
    expect(result.current.onCreateTag).toBe(params.handleTagCreate);
    expect(result.current.onEditTag).toBe(params.handleTagEdit);
    expect(result.current.onDeleteTag).toBe(params.handleTagDeleteClick);

    // Accordion state
    expect(result.current.selectedTags).toBe(params.selectedTags);
    expect(result.current.selectedFolders).toBe(params.selectedFolders);
    expect(result.current.isOpen).toBe(params.isOpen);
    expect(result.current.toggleSection).toBe(params.toggleSection);

    // Pass-through props
    expect(result.current.t).toBe(params.t);
    expect(result.current.tTeam).toBe(params.tTeam);
    expect(result.current.vaultContext).toBe(params.vaultContext);
    expect(result.current.teams).toBe(params.teams);
    expect(result.current.selectedTeam).toBe(params.selectedTeam);
    expect(result.current.selectedTeamCanManageFolders).toBe(false);
    expect(result.current.selectedTeamCanManageTags).toBe(false);
    expect(result.current.selectedTypeFilter).toBeNull();
    expect(result.current.selectedFolderId).toBeNull();
    expect(result.current.selectedTagId).toBeNull();
    expect(result.current.isSelectedVaultAll).toBe(true);
    expect(result.current.isSelectedVaultFavorites).toBe(false);
    expect(result.current.isSelectedVaultArchive).toBe(false);
    expect(result.current.isSelectedVaultTrash).toBe(false);
    expect(result.current.isWatchtower).toBe(false);
    expect(result.current.isShareLinks).toBe(false);
    expect(result.current.isEmergencyAccess).toBe(false);
    expect(result.current.isPersonalAuditLog).toBe(false);
    expect(result.current.activeAuditTeamId).toBeNull();
  });
});
