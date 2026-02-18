"use client";

import { useMemo } from "react";
import { ORG_ROLE } from "@/lib/constants";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import type {
  SidebarFolderItem,
  SidebarOrgFolderGroup,
  SidebarOrgItem,
  SidebarOrgTagGroup,
  SidebarTagItem,
} from "@/hooks/use-sidebar-data";
import type { VaultContext } from "@/hooks/use-vault-context";

interface UseSidebarNavigationStateParams {
  pathname: string;
  searchParams: URLSearchParams;
  vaultContext: VaultContext;
  orgs: SidebarOrgItem[];
  folders: SidebarFolderItem[];
  tags: SidebarTagItem[];
  orgFolderGroups: SidebarOrgFolderGroup[];
  orgTagGroups: SidebarOrgTagGroup[];
}

export function useSidebarNavigationState({
  pathname,
  searchParams,
  vaultContext,
  orgs,
  folders,
  tags,
  orgFolderGroups,
  orgTagGroups,
}: UseSidebarNavigationStateParams) {
  return useMemo(() => {
    const cleanPath = stripLocalePrefix(pathname);

    const activeTypeFilter = cleanPath === "/dashboard" ? searchParams.get("type") : null;
    const isVaultAll = cleanPath === "/dashboard" && !activeTypeFilter;
    const isVaultFavorites = cleanPath === "/dashboard/favorites";
    const isVaultArchive = cleanPath === "/dashboard/archive";
    const isVaultTrash = cleanPath === "/dashboard/trash";
    const isWatchtower = cleanPath === "/dashboard/watchtower";
    const isAuditLog = cleanPath === "/dashboard/audit-logs" || cleanPath.endsWith("/audit-logs");
    const isPersonalAuditLog = cleanPath === "/dashboard/audit-logs";
    const auditOrgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)\/audit-logs$/);
    const activeAuditOrgId = auditOrgMatch ? auditOrgMatch[1] : null;
    const tagMatch = cleanPath.match(/^\/dashboard\/tags\/([^/]+)/);
    const activeTagId = tagMatch ? tagMatch[1] : null;
    const folderMatch = cleanPath.match(/^\/dashboard\/folders\/([^/]+)/);
    const activeFolderId = folderMatch ? folderMatch[1] : null;
    const orgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)/);
    const activeOrgId = orgMatch && !isAuditLog ? orgMatch[1] : null;
    const activeOrgTagId = activeOrgId ? searchParams.get("tag") : null;
    const activeOrgFolderId = activeOrgId ? searchParams.get("folder") : null;
    const activeOrgTypeFilter = activeOrgId ? searchParams.get("type") : null;
    const activeOrgScope = activeOrgId ? searchParams.get("scope") : null;
    const isOrgsManage = cleanPath === "/dashboard/orgs";
    const isShareLinks = cleanPath === "/dashboard/share-links";
    const isEmergencyAccess =
      cleanPath === "/dashboard/emergency-access" ||
      cleanPath.startsWith("/dashboard/emergency-access/");

    const selectedOrgId = vaultContext.type === "org" ? vaultContext.orgId : null;
    const selectedOrg = selectedOrgId ? orgs.find((org) => org.id === selectedOrgId) ?? null : null;
    const selectedOrgFolderGroup = selectedOrgId
      ? orgFolderGroups.find((group) => group.orgId === selectedOrgId)
      : null;
    const selectedOrgTagGroup = selectedOrgId
      ? orgTagGroups.find((group) => group.orgId === selectedOrgId)
      : null;

    const selectedOrgCanManageFolders = selectedOrg
      ? selectedOrg.role !== ORG_ROLE.VIEWER
      : false;
    const selectedOrgCanManageTags = selectedOrg
      ? selectedOrg.role !== ORG_ROLE.VIEWER
      : false;

    const selectedOrgTypeFilter =
      selectedOrgId && activeOrgId === selectedOrgId ? activeOrgTypeFilter : null;
    const selectedOrgScope = selectedOrgId && activeOrgId === selectedOrgId ? activeOrgScope : null;
    const selectedOrgFolderId =
      selectedOrgId && activeOrgId === selectedOrgId ? activeOrgFolderId : null;
    const selectedOrgTagId = selectedOrgId && activeOrgId === selectedOrgId ? activeOrgTagId : null;

    const selectedTypeFilter =
      vaultContext.type === "org" ? selectedOrgTypeFilter : activeTypeFilter;
    const selectedFolderId =
      vaultContext.type === "org" ? selectedOrgFolderId : activeFolderId;
    const selectedTagId = vaultContext.type === "org" ? selectedOrgTagId : activeTagId;

    const isSelectedVaultAll =
      vaultContext.type === "org"
        ? activeOrgId === selectedOrgId &&
          !selectedOrgTypeFilter &&
          !selectedOrgScope &&
          !selectedOrgTagId &&
          !selectedOrgFolderId
        : isVaultAll;

    const isSelectedVaultFavorites =
      vaultContext.type === "org"
        ? activeOrgId === selectedOrgId && selectedOrgScope === "favorites"
        : isVaultFavorites;

    const isSelectedVaultArchive =
      vaultContext.type === "org"
        ? activeOrgId === selectedOrgId && selectedOrgScope === "archive"
        : isVaultArchive;

    const isSelectedVaultTrash =
      vaultContext.type === "org"
        ? activeOrgId === selectedOrgId && selectedOrgScope === "trash"
        : isVaultTrash;

    const selectedFolders =
      vaultContext.type === "org" ? selectedOrgFolderGroup?.folders ?? [] : folders;

    const selectedTags =
      vaultContext.type === "org"
        ? selectedOrgTagGroup?.tags.map((tag) => ({
            id: tag.id,
            name: tag.name,
            color: tag.color,
            count: tag.count,
          }))
            .filter((tag) => tag.count > 0) ?? []
        : tags
            .filter((tag) => tag.passwordCount > 0)
            .map((tag) => ({
              id: tag.id,
              name: tag.name,
              color: tag.color,
              count: tag.passwordCount,
            }));

    return {
      activeOrgId,
      activeAuditOrgId,
      isOrgsManage,
      isWatchtower,
      isShareLinks,
      isEmergencyAccess,
      isAuditLog,
      isPersonalAuditLog,
      selectedOrgId,
      selectedOrg,
      selectedOrgCanManageFolders,
      selectedOrgCanManageTags,
      selectedTypeFilter,
      selectedFolderId,
      selectedTagId,
      isSelectedVaultAll,
      isSelectedVaultFavorites,
      isSelectedVaultArchive,
      isSelectedVaultTrash,
      selectedFolders,
      selectedTags,
    };
  }, [pathname, searchParams, vaultContext, orgs, folders, tags, orgFolderGroups, orgTagGroups]);
}
