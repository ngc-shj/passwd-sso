"use client";

import { useCallback } from "react";
import type { SidebarContentProps } from "@/components/layout/sidebar-content";
import type {
  SidebarFolderItem,
  SidebarTeamItem,
  SidebarTeamTagItem,
} from "@/hooks/use-sidebar-data";
import type { SidebarSection } from "@/hooks/use-sidebar-sections-state";
import type { VaultContext } from "@/hooks/use-vault-context";

interface UseSidebarViewModelParams {
  t: (key: string) => string;
  tTeam: (key: string) => string;
  router: { push: (href: string) => void };
  onOpenChange: (open: boolean) => void;
  vaultContext: VaultContext;
  teams: SidebarTeamItem[];
  selectedTeam: SidebarTeamItem | null;
  selectedTeamCanManageFolders?: boolean;
  selectedTeamCanManageTags?: boolean;
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
  activeAuditTeamId: string | null;
  selectedFolders: SidebarFolderItem[];
  selectedTags: SidebarTeamTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  handleFolderCreate: (teamId?: string) => void;
  handleFolderEdit: (folder: SidebarFolderItem, teamId?: string) => void;
  handleFolderDeleteClick: (folder: SidebarFolderItem, teamId?: string) => void;
  handleTagCreate: (teamId?: string) => void;
  handleTagEdit: (tag: SidebarTeamTagItem, teamId?: string) => void;
  handleTagDeleteClick: (tag: SidebarTeamTagItem, teamId?: string) => void;
}

export function useSidebarViewModel({
  t,
  tTeam,
  router,
  onOpenChange,
  vaultContext,
  teams,
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
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isPersonalAuditLog,
  activeAuditTeamId,
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
  const teamItems = teams;
  const canManageFolders = selectedTeamCanManageFolders ?? false;
  const canManageTags = selectedTeamCanManageTags ?? false;
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
    tTeam,
    vaultContext,
    teams: teamItems,
    selectedTeam,
    selectedTeamCanManageFolders: canManageFolders,
    selectedTeamCanManageTags: canManageTags,
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
