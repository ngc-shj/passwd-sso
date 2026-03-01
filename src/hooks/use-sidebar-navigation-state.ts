"use client";

import { useMemo } from "react";
import { TEAM_ROLE } from "@/lib/constants";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import type {
  SidebarFolderItem,
  SidebarTeamFolderGroup,
  SidebarTeamItem,
  SidebarTeamTagGroup,
  SidebarTagItem,
} from "@/hooks/use-sidebar-data";
import type { VaultContext } from "@/hooks/use-vault-context";

interface UseSidebarNavigationStateParams {
  pathname: string;
  searchParams: URLSearchParams;
  vaultContext: VaultContext;
  teams: SidebarTeamItem[];
  folders: SidebarFolderItem[];
  tags: SidebarTagItem[];
  teamFolderGroups: SidebarTeamFolderGroup[];
  teamTagGroups: SidebarTeamTagGroup[];
}

export function useSidebarNavigationState({
  pathname,
  searchParams,
  vaultContext,
  teams,
  folders,
  tags,
  teamFolderGroups,
  teamTagGroups,
}: UseSidebarNavigationStateParams) {
  const teamItems = teams;
  const scopedFolderGroups = teamFolderGroups;
  const scopedTagGroups = teamTagGroups;
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
    const auditTeamMatch = cleanPath.match(/^\/dashboard\/teams\/([^/]+)\/audit-logs$/);
    const activeAuditTeamId = auditTeamMatch ? auditTeamMatch[1] : null;
    const tagMatch = cleanPath.match(/^\/dashboard\/tags\/([^/]+)/);
    const activeTagId = tagMatch ? tagMatch[1] : null;
    const folderMatch = cleanPath.match(/^\/dashboard\/folders\/([^/]+)/);
    const activeFolderId = folderMatch ? folderMatch[1] : null;
    const teamMatch = cleanPath.match(/^\/dashboard\/teams\/([^/]+)/);
    const activeTeamId = teamMatch && !isAuditLog ? teamMatch[1] : null;
    const activeTeamTagId = activeTeamId ? searchParams.get("tag") : null;
    const activeTeamFolderId = activeTeamId ? searchParams.get("folder") : null;
    const activeTeamTypeFilter = activeTeamId ? searchParams.get("type") : null;
    const activeTeamScope = activeTeamId ? searchParams.get("scope") : null;
    const isTeamsManage = cleanPath === "/dashboard/teams";
    const isTeamSettings = teamMatch
      ? cleanPath === `/dashboard/teams/${teamMatch[1]}/settings`
      : false;
    const isSettings = cleanPath === "/dashboard/settings";
    const isExport = teamMatch
      ? cleanPath === `/dashboard/teams/${teamMatch[1]}/export`
      : cleanPath === "/dashboard/export";
    const isImport = teamMatch
      ? cleanPath === `/dashboard/teams/${teamMatch[1]}/import`
      : cleanPath === "/dashboard/import";
    const isShareLinks = cleanPath === "/dashboard/share-links";
    const isEmergencyAccess =
      cleanPath === "/dashboard/emergency-access" ||
      cleanPath.startsWith("/dashboard/emergency-access/");

    const selectedTeamId = vaultContext.type === "team" ? vaultContext.teamId : null;
    const selectedTeam = selectedTeamId ? teamItems.find((team) => team.id === selectedTeamId) ?? null : null;
    const selectedTeamFolderGroup = selectedTeamId
      ? scopedFolderGroups.find((group) => group.teamId === selectedTeamId)
      : null;
    const selectedTeamTagGroup = selectedTeamId
      ? scopedTagGroups.find((group) => group.teamId === selectedTeamId)
      : null;

    const selectedTeamCanManageFolders = selectedTeam
      ? selectedTeam.role !== TEAM_ROLE.VIEWER
      : false;
    const selectedTeamCanManageTags = selectedTeam
      ? selectedTeam.role !== TEAM_ROLE.VIEWER
      : false;

    const selectedTeamTypeFilter =
      selectedTeamId && activeTeamId === selectedTeamId ? activeTeamTypeFilter : null;
    const selectedTeamScope = selectedTeamId && activeTeamId === selectedTeamId ? activeTeamScope : null;
    const selectedTeamFolderId =
      selectedTeamId && activeTeamId === selectedTeamId ? activeTeamFolderId : null;
    const selectedTeamTagId = selectedTeamId && activeTeamId === selectedTeamId ? activeTeamTagId : null;

    const selectedTypeFilter =
      vaultContext.type === "team" ? selectedTeamTypeFilter : activeTypeFilter;
    const selectedFolderId =
      vaultContext.type === "team" ? selectedTeamFolderId : activeFolderId;
    const selectedTagId = vaultContext.type === "team" ? selectedTeamTagId : activeTagId;

    const isSelectedVaultAll =
      vaultContext.type === "team"
        ? activeTeamId === selectedTeamId &&
          !selectedTeamTypeFilter &&
          !selectedTeamScope &&
          !selectedTeamTagId &&
          !selectedTeamFolderId &&
          !isTeamSettings &&
          !isExport &&
          !isImport
        : isVaultAll;

    const isSelectedVaultFavorites =
      vaultContext.type === "team"
        ? activeTeamId === selectedTeamId && selectedTeamScope === "favorites"
        : isVaultFavorites;

    const isSelectedVaultArchive =
      vaultContext.type === "team"
        ? activeTeamId === selectedTeamId && selectedTeamScope === "archive"
        : isVaultArchive;

    const isSelectedVaultTrash =
      vaultContext.type === "team"
        ? activeTeamId === selectedTeamId && selectedTeamScope === "trash"
        : isVaultTrash;

    const selectedFolders =
      vaultContext.type === "team" ? selectedTeamFolderGroup?.folders ?? [] : folders;

    const selectedTags =
      vaultContext.type === "team"
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
      activeAuditTeamId,
      isTeamsManage,
      isTeamSettings,
      isSettings,
      isExport,
      isImport,
      isWatchtower,
      isShareLinks,
      isEmergencyAccess,
      isAuditLog,
      isPersonalAuditLog,
      selectedTeamId,
      selectedTeam,
      selectedTeamCanManageFolders,
      selectedTeamCanManageTags,
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
