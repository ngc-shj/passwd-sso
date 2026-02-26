"use client";

import { useCallback } from "react";
import type { SidebarContentProps } from "@/components/layout/sidebar-content";
import type {
  SidebarFolderItem,
  SidebarOrgItem,
  SidebarOrganizeTagItem,
} from "@/hooks/use-sidebar-data";
import type { SidebarSection } from "@/hooks/use-sidebar-sections-state";
import type { VaultContext } from "@/hooks/use-vault-context";

interface UseSidebarViewModelParams {
  t: (key: string) => string;
  tOrg: (key: string) => string;
  router: { push: (href: string) => void };
  onOpenChange: (open: boolean) => void;
  vaultContext: VaultContext;
  teams?: SidebarOrgItem[];
  orgs?: SidebarOrgItem[];
  selectedTeam?: SidebarOrgItem | null;
  selectedOrg?: SidebarOrgItem | null;
  selectedTeamCanManageFolders?: boolean;
  selectedOrgCanManageFolders?: boolean;
  selectedTeamCanManageTags?: boolean;
  selectedOrgCanManageTags?: boolean;
  selectedTypeFilter: string | null;
  selectedFolderId: string | null;
  selectedTagId: string | null;
  isSelectedVaultAll: boolean;
  isSelectedVaultFavorites: boolean;
  isSelectedVaultArchive: boolean;
  isSelectedVaultTrash: boolean;
  isWatchtower: boolean;
  isShareLinks: boolean;
  isEmergencyAccess: boolean;
  isPersonalAuditLog: boolean;
  activeAuditTeamId?: string | null;
  activeAuditOrgId?: string | null;
  selectedFolders: SidebarFolderItem[];
  selectedTags: SidebarOrganizeTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  handleFolderCreate: (orgId?: string) => void;
  handleFolderEdit: (folder: SidebarFolderItem, orgId?: string) => void;
  handleFolderDeleteClick: (folder: SidebarFolderItem, orgId?: string) => void;
  handleTagCreate: (orgId?: string) => void;
  handleTagEdit: (tag: SidebarOrganizeTagItem, orgId?: string) => void;
  handleTagDeleteClick: (tag: SidebarOrganizeTagItem, orgId?: string) => void;
}

export function useSidebarViewModel({
  t,
  tOrg,
  router,
  onOpenChange,
  vaultContext,
  teams,
  orgs,
  selectedTeam,
  selectedOrg,
  selectedTeamCanManageFolders,
  selectedOrgCanManageFolders,
  selectedTeamCanManageTags,
  selectedOrgCanManageTags,
  selectedTypeFilter,
  selectedFolderId,
  selectedTagId,
  isSelectedVaultAll,
  isSelectedVaultFavorites,
  isSelectedVaultArchive,
  isSelectedVaultTrash,
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isPersonalAuditLog,
  activeAuditTeamId,
  activeAuditOrgId,
  selectedFolders,
  selectedTags,
  isOpen,
  toggleSection,
  handleFolderCreate,
  handleFolderEdit,
  handleFolderDeleteClick,
  handleTagCreate,
  handleTagEdit,
  handleTagDeleteClick,
}: UseSidebarViewModelParams): SidebarContentProps {
  const teamItems = teams ?? orgs ?? [];
  const selectedTeamItem = selectedTeam ?? selectedOrg ?? null;
  const canManageFolders = selectedTeamCanManageFolders ?? selectedOrgCanManageFolders ?? false;
  const canManageTags = selectedTeamCanManageTags ?? selectedOrgCanManageTags ?? false;
  const activeAuditTeam = activeAuditTeamId ?? activeAuditOrgId ?? null;
  const onNavigate = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const onVaultChange = useCallback(
    (value: string) => {
      if (value === "personal") {
        router.push("/dashboard");
        onOpenChange(false);
        return;
      }
      router.push(`/dashboard/teams/${value}`);
      onOpenChange(false);
    },
    [router, onOpenChange],
  );

  return {
    t,
    tOrg,
    vaultContext,
    teams: teamItems,
    selectedOrg: selectedTeamItem,
    selectedOrgCanManageFolders: canManageFolders,
    selectedOrgCanManageTags: canManageTags,
    selectedTypeFilter,
    selectedFolderId,
    selectedTagId,
    isSelectedVaultAll,
    isSelectedVaultFavorites,
    isSelectedVaultArchive,
    isSelectedVaultTrash,
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isPersonalAuditLog,
    activeAuditOrgId: activeAuditTeam,
    selectedFolders,
    selectedTags,
    isOpen,
    toggleSection,
    onVaultChange,
    onCreateFolder: handleFolderCreate,
    onCreateTag: handleTagCreate,
    onEditFolder: handleFolderEdit,
    onDeleteFolder: handleFolderDeleteClick,
    onEditTag: handleTagEdit,
    onDeleteTag: handleTagDeleteClick,
    onNavigate,
  };
}
