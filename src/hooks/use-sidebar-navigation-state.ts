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
  teams?: SidebarOrgItem[];
  orgs?: SidebarOrgItem[];
  folders: SidebarFolderItem[];
  tags: SidebarTagItem[];
  teamFolderGroups?: SidebarOrgFolderGroup[];
  orgFolderGroups?: SidebarOrgFolderGroup[];
  teamTagGroups?: SidebarOrgTagGroup[];
  orgTagGroups?: SidebarOrgTagGroup[];
}

export function useSidebarNavigationState({
  pathname,
  searchParams,
  vaultContext,
  teams,
  orgs,
  folders,
  tags,
  teamFolderGroups,
  orgFolderGroups,
  teamTagGroups,
  orgTagGroups,
}: UseSidebarNavigationStateParams) {
  const teamItems = teams ?? orgs ?? [];
  const scopedFolderGroups = teamFolderGroups ?? orgFolderGroups ?? [];
  const scopedTagGroups = teamTagGroups ?? orgTagGroups ?? [];
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
    const auditTeamMatch = cleanPath.match(/^\/dashboard\/(?:teams|orgs)\/([^/]+)\/audit-logs$/);
    const activeAuditTeamId = auditTeamMatch ? auditTeamMatch[1] : null;
    const tagMatch = cleanPath.match(/^\/dashboard\/tags\/([^/]+)/);
    const activeTagId = tagMatch ? tagMatch[1] : null;
    const folderMatch = cleanPath.match(/^\/dashboard\/folders\/([^/]+)/);
    const activeFolderId = folderMatch ? folderMatch[1] : null;
    const teamMatch = cleanPath.match(/^\/dashboard\/(?:teams|orgs)\/([^/]+)/);
    const activeTeamId = teamMatch && !isAuditLog ? teamMatch[1] : null;
    const activeTeamTagId = activeTeamId ? searchParams.get("tag") : null;
    const activeTeamFolderId = activeTeamId ? searchParams.get("folder") : null;
    const activeTeamTypeFilter = activeTeamId ? searchParams.get("type") : null;
    const activeTeamScope = activeTeamId ? searchParams.get("scope") : null;
    const isTeamsManage = cleanPath === "/dashboard/teams" || cleanPath === "/dashboard/orgs";
    const isShareLinks = cleanPath === "/dashboard/share-links";
    const isEmergencyAccess =
      cleanPath === "/dashboard/emergency-access" ||
      cleanPath.startsWith("/dashboard/emergency-access/");

    const selectedTeamId = vaultContext.type === "org" ? vaultContext.orgId : null;
    const selectedTeam = selectedTeamId ? teamItems.find((team) => team.id === selectedTeamId) ?? null : null;
    const selectedTeamFolderGroup = selectedTeamId
      ? scopedFolderGroups.find((group) => group.orgId === selectedTeamId)
      : null;
    const selectedTeamTagGroup = selectedTeamId
      ? scopedTagGroups.find((group) => group.orgId === selectedTeamId)
      : null;

    const selectedTeamCanManageFolders = selectedTeam
      ? selectedTeam.role !== ORG_ROLE.VIEWER
      : false;
    const selectedTeamCanManageTags = selectedTeam
      ? selectedTeam.role !== ORG_ROLE.VIEWER
      : false;

    const selectedTeamTypeFilter =
      selectedTeamId && activeTeamId === selectedTeamId ? activeTeamTypeFilter : null;
    const selectedTeamScope = selectedTeamId && activeTeamId === selectedTeamId ? activeTeamScope : null;
    const selectedTeamFolderId =
      selectedTeamId && activeTeamId === selectedTeamId ? activeTeamFolderId : null;
    const selectedTeamTagId = selectedTeamId && activeTeamId === selectedTeamId ? activeTeamTagId : null;

    const selectedTypeFilter =
      vaultContext.type === "org" ? selectedTeamTypeFilter : activeTypeFilter;
    const selectedFolderId =
      vaultContext.type === "org" ? selectedTeamFolderId : activeFolderId;
    const selectedTagId = vaultContext.type === "org" ? selectedTeamTagId : activeTagId;

    const isSelectedVaultAll =
      vaultContext.type === "org"
        ? activeTeamId === selectedTeamId &&
          !selectedTeamTypeFilter &&
          !selectedTeamScope &&
          !selectedTeamTagId &&
          !selectedTeamFolderId
        : isVaultAll;

    const isSelectedVaultFavorites =
      vaultContext.type === "org"
        ? activeTeamId === selectedTeamId && selectedTeamScope === "favorites"
        : isVaultFavorites;

    const isSelectedVaultArchive =
      vaultContext.type === "org"
        ? activeTeamId === selectedTeamId && selectedTeamScope === "archive"
        : isVaultArchive;

    const isSelectedVaultTrash =
      vaultContext.type === "org"
        ? activeTeamId === selectedTeamId && selectedTeamScope === "trash"
        : isVaultTrash;

    const selectedFolders =
      vaultContext.type === "org" ? selectedTeamFolderGroup?.folders ?? [] : folders;

    const selectedTags =
      vaultContext.type === "org"
        ? selectedTeamTagGroup?.tags.map((tag) => ({
            id: tag.id,
            name: tag.name,
            color: tag.color,
            count: tag.count,
          })) ?? []
        : tags.map((tag) => ({
              id: tag.id,
              name: tag.name,
              color: tag.color,
              count: tag.passwordCount,
            }));

    return {
      activeTeamId,
      activeOrgId: activeTeamId,
      activeAuditTeamId,
      activeAuditOrgId: activeAuditTeamId,
      isTeamsManage,
      isOrgsManage: isTeamsManage,
      isWatchtower,
      isShareLinks,
      isEmergencyAccess,
      isAuditLog,
      isPersonalAuditLog,
      selectedTeamId,
      selectedOrgId: selectedTeamId,
      selectedTeam,
      selectedOrg: selectedTeam,
      selectedTeamCanManageFolders,
      selectedOrgCanManageFolders: selectedTeamCanManageFolders,
      selectedTeamCanManageTags,
      selectedOrgCanManageTags: selectedTeamCanManageTags,
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
  }, [pathname, searchParams, vaultContext, teamItems, folders, tags, scopedFolderGroups, scopedTagGroups]);
}
