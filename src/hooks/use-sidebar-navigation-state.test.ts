// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSidebarNavigationState } from "./use-sidebar-navigation-state";

const teams = [{ id: "team-1", name: "Acme", slug: "acme", role: "ADMIN" }];
const folders = [{ id: "f1", name: "Personal", parentId: null, sortOrder: 0, entryCount: 1 }];
const tags = [
  { id: "t1", name: "keep", color: null, passwordCount: 2 },
  { id: "t2", name: "skip", color: null, passwordCount: 0 },
];
const teamFolderGroups = [
  {
    teamId: "team-1",
    teamName: "Acme",
    teamRole: "ADMIN",
    folders: [{ id: "of1", name: "TeamFolder", parentId: null, sortOrder: 0, entryCount: 3 }],
  },
];
const teamTagGroups = [
  {
    teamId: "team-1",
    teamName: "Acme",
    tags: [
      { id: "ot1", name: "TeamTag", color: "blue", count: 4 },
      { id: "ot2", name: "TeamEmpty", color: null, count: 0 },
    ],
  },
];

describe("useSidebarNavigationState", () => {
  it("derives personal navigation state from personal dashboard path", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/tags/t1",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "personal" },
        teams,
        folders,
        tags,
        teamFolderGroups,
        teamTagGroups,
      }),
    );

    expect(result.current.selectedTeamId).toBeNull();
    expect(result.current.selectedTagId).toBe("t1");
    expect(result.current.selectedFolders).toEqual(folders);
    expect(result.current.selectedTags).toEqual([
      { id: "t1", name: "keep", color: null, count: 2 },
      { id: "t2", name: "skip", color: null, count: 0 },
    ]);
  });

  it("derives team navigation state and scope-specific flags", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/teams/team-1",
        searchParams: new URLSearchParams("scope=favorites&type=LOGIN&tag=ot1&folder=of1"),
        vaultContext: { type: "team", teamId: "team-1" },
        teams,
        folders,
        tags,
        teamFolderGroups,
        teamTagGroups,
      }),
    );

    expect(result.current.selectedTeamId).toBe("team-1");
    expect(result.current.selectedTeamCanManageFolders).toBe(true);
    expect(result.current.selectedTeamCanManageTags).toBe(true);
    expect(result.current.selectedTypeFilter).toBe("LOGIN");
    expect(result.current.selectedTagId).toBe("ot1");
    expect(result.current.selectedFolderId).toBe("of1");
    expect(result.current.isSelectedVaultFavorites).toBe(true);
    expect(result.current.selectedFolders).toEqual(teamFolderGroups[0].folders);
    expect(result.current.selectedTags).toEqual([
      { id: "ot1", name: "TeamTag", color: "blue", count: 4 },
      { id: "ot2", name: "TeamEmpty", color: null, count: 0 },
    ]);
  });

  it("detects team audit log path separately", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/teams/team-1/audit-logs",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "team", teamId: "team-1" },
        teams,
        folders,
        tags,
        teamFolderGroups,
        teamTagGroups,
      }),
    );

    expect(result.current.isAuditLog).toBe(true);
    expect(result.current.activeAuditTeamId).toBe("team-1");
    expect(result.current.activeTeamId).toBeNull();
  });

  it("allows MEMBER to manage folders and tags in team context", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/teams/team-1",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "team", teamId: "team-1" },
        teams: [{ id: "team-1", name: "Acme", slug: "acme", role: "MEMBER" }],
        folders,
        tags,
        teamFolderGroups,
        teamTagGroups,
      }),
    );

    expect(result.current.selectedTeamCanManageFolders).toBe(true);
    expect(result.current.selectedTeamCanManageTags).toBe(true);
  });

  it("includes zero-count team tags", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/teams/team-1",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "team", teamId: "team-1" },
        teams,
        folders,
        tags,
        teamFolderGroups,
        teamTagGroups,
      }),
    );

    expect(result.current.selectedTags).toEqual([
      { id: "ot1", name: "TeamTag", color: "blue", count: 4 },
      { id: "ot2", name: "TeamEmpty", color: null, count: 0 },
    ]);
  });
});
