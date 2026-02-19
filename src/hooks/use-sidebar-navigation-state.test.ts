// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSidebarNavigationState } from "./use-sidebar-navigation-state";

const orgs = [{ id: "org-1", name: "Acme", slug: "acme", role: "ADMIN" }];
const folders = [{ id: "f1", name: "Personal", parentId: null, sortOrder: 0, entryCount: 1 }];
const tags = [
  { id: "t1", name: "keep", color: null, passwordCount: 2 },
  { id: "t2", name: "skip", color: null, passwordCount: 0 },
];
const orgFolderGroups = [
  {
    orgId: "org-1",
    orgName: "Acme",
    orgRole: "ADMIN",
    folders: [{ id: "of1", name: "OrgFolder", parentId: null, sortOrder: 0, entryCount: 3 }],
  },
];
const orgTagGroups = [
  {
    orgId: "org-1",
    orgName: "Acme",
    tags: [
      { id: "ot1", name: "OrgTag", color: "blue", count: 4 },
      { id: "ot2", name: "OrgEmpty", color: null, count: 0 },
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
        orgs,
        folders,
        tags,
        orgFolderGroups,
        orgTagGroups,
      }),
    );

    expect(result.current.selectedOrgId).toBeNull();
    expect(result.current.selectedTagId).toBe("t1");
    expect(result.current.selectedFolders).toEqual(folders);
    expect(result.current.selectedTags).toEqual([
      { id: "t1", name: "keep", color: null, count: 2 },
    ]);
  });

  it("derives org navigation state and scope-specific flags", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/orgs/org-1",
        searchParams: new URLSearchParams("scope=favorites&type=LOGIN&tag=ot1&folder=of1"),
        vaultContext: { type: "org", orgId: "org-1" },
        orgs,
        folders,
        tags,
        orgFolderGroups,
        orgTagGroups,
      }),
    );

    expect(result.current.selectedOrgId).toBe("org-1");
    expect(result.current.selectedOrgCanManageFolders).toBe(true);
    expect(result.current.selectedOrgCanManageTags).toBe(true);
    expect(result.current.selectedTypeFilter).toBe("LOGIN");
    expect(result.current.selectedTagId).toBe("ot1");
    expect(result.current.selectedFolderId).toBe("of1");
    expect(result.current.isSelectedVaultFavorites).toBe(true);
    expect(result.current.selectedFolders).toEqual(orgFolderGroups[0].folders);
    expect(result.current.selectedTags).toEqual([{ id: "ot1", name: "OrgTag", color: "blue", count: 4 }]);
  });

  it("detects org audit log path separately", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/orgs/org-1/audit-logs",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "org", orgId: "org-1" },
        orgs,
        folders,
        tags,
        orgFolderGroups,
        orgTagGroups,
      }),
    );

    expect(result.current.isAuditLog).toBe(true);
    expect(result.current.activeAuditOrgId).toBe("org-1");
    expect(result.current.activeOrgId).toBeNull();
  });

  it("allows MEMBER to manage folders and tags in org context", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/orgs/org-1",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "org", orgId: "org-1" },
        orgs: [{ id: "org-1", name: "Acme", slug: "acme", role: "MEMBER" }],
        folders,
        tags,
        orgFolderGroups,
        orgTagGroups,
      }),
    );

    expect(result.current.selectedOrgCanManageFolders).toBe(true);
    expect(result.current.selectedOrgCanManageTags).toBe(true);
  });

  it("filters out zero-count org tags for consistency with personal tags", () => {
    const { result } = renderHook(() =>
      useSidebarNavigationState({
        pathname: "/ja/dashboard/orgs/org-1",
        searchParams: new URLSearchParams(),
        vaultContext: { type: "org", orgId: "org-1" },
        orgs,
        folders,
        tags,
        orgFolderGroups,
        orgTagGroups,
      }),
    );

    expect(result.current.selectedTags).toEqual([
      { id: "ot1", name: "OrgTag", color: "blue", count: 4 },
    ]);
  });
});
