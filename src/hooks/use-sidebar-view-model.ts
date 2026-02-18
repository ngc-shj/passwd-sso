"use client";

import { useCallback } from "react";
import type { SidebarContentProps } from "@/components/layout/sidebar-content";
import type { SidebarFolderItem, SidebarOrgItem } from "@/hooks/use-sidebar-data";
import type { SidebarSection } from "@/hooks/use-sidebar-sections-state";
import type { VaultContext } from "@/hooks/use-vault-context";

interface OrganizeTagItem {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

interface UseSidebarViewModelParams {
  t: (key: string) => string;
  tOrg: (key: string) => string;
  router: { push: (href: string) => void };
  onOpenChange: (open: boolean) => void;
  vaultContext: VaultContext;
  orgs: SidebarOrgItem[];
  selectedOrg: SidebarOrgItem | null;
  selectedOrgCanManageFolders: boolean;
  selectedOrgCanManageTags: boolean;
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
  activeAuditOrgId: string | null;
  selectedFolders: SidebarFolderItem[];
  selectedTags: OrganizeTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  handleFolderCreate: (orgId?: string) => void;
  handleFolderEdit: (folder: SidebarFolderItem, orgId?: string) => void;
  handleFolderDeleteClick: (folder: SidebarFolderItem, orgId?: string) => void;
  handleTagEdit: (tag: OrganizeTagItem, orgId?: string) => void;
  handleTagDeleteClick: (tag: OrganizeTagItem, orgId?: string) => void;
}

export function useSidebarViewModel({
  t,
  tOrg,
  router,
  onOpenChange,
  vaultContext,
  orgs,
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
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isPersonalAuditLog,
  activeAuditOrgId,
  selectedFolders,
  selectedTags,
  isOpen,
  toggleSection,
  handleFolderCreate,
  handleFolderEdit,
  handleFolderDeleteClick,
  handleTagEdit,
  handleTagDeleteClick,
}: UseSidebarViewModelParams): SidebarContentProps {
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
      router.push(`/dashboard/orgs/${value}`);
      onOpenChange(false);
    },
    [router, onOpenChange],
  );

  return {
    t,
    tOrg,
    vaultContext,
    orgs,
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
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isPersonalAuditLog,
    activeAuditOrgId,
    selectedFolders,
    selectedTags,
    isOpen,
    toggleSection,
    onVaultChange,
    onCreateFolder: handleFolderCreate,
    onEditFolder: handleFolderEdit,
    onDeleteFolder: handleFolderDeleteClick,
    onEditTag: handleTagEdit,
    onDeleteTag: handleTagDeleteClick,
    onNavigate,
  };
}
