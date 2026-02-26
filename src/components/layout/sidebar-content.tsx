"use client";

import { Separator } from "@/components/ui/separator";
import { VaultSelector } from "@/components/layout/vault-selector";
import { SecuritySection, UtilitiesSection } from "@/components/layout/sidebar-section-security";
import {
  VaultSection,
  CategoriesSection,
  OrganizeSection,
  VaultManagementSection,
} from "@/components/layout/sidebar-sections";
import type { SidebarSection } from "@/hooks/use-sidebar-sections-state";
import type {
  SidebarFolderItem,
  SidebarOrgItem,
  SidebarOrganizeTagItem,
} from "@/hooks/use-sidebar-data";
import type { VaultContext } from "@/hooks/use-vault-context";

export interface SidebarContentProps {
  t: (key: string) => string;
  tOrg: (key: string) => string;
  vaultContext: VaultContext;
  teams?: SidebarOrgItem[];
  orgs?: SidebarOrgItem[];
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
  selectedTags: SidebarOrganizeTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  onVaultChange: (value: string) => void;
  onCreateFolder: (orgId?: string) => void;
  onCreateTag: (orgId?: string) => void;
  onEditFolder: (folder: SidebarFolderItem, orgId?: string) => void;
  onDeleteFolder: (folder: SidebarFolderItem, orgId?: string) => void;
  onEditTag: (tag: SidebarOrganizeTagItem, orgId?: string) => void;
  onDeleteTag: (tag: SidebarOrganizeTagItem, orgId?: string) => void;
  onNavigate: () => void;
}

export function SidebarContent({
  t,
  tOrg,
  vaultContext,
  teams,
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
  onCreateFolder,
  onCreateTag,
  onEditFolder,
  onDeleteFolder,
  onEditTag,
  onDeleteTag,
  onNavigate,
}: SidebarContentProps) {
  const teamItems = teams ?? orgs ?? [];
  const scopedTeamId =
    vaultContext.type === "org" ? (vaultContext.teamId ?? vaultContext.orgId) : "";
  return (
    <nav className="space-y-4 p-4">
      <VaultSelector
        value={vaultContext.type === "org" ? scopedTeamId : "personal"}
        teams={teamItems}
        onValueChange={onVaultChange}
      />

      <VaultSection
        t={t}
        vaultContext={vaultContext}
        isSelectedVaultAll={isSelectedVaultAll}
        isSelectedVaultFavorites={isSelectedVaultFavorites}
        onNavigate={onNavigate}
      />

      <CategoriesSection
        isOpen={isOpen("categories")}
        onOpenChange={toggleSection("categories")}
        t={t}
        vaultContext={vaultContext}
        selectedTypeFilter={selectedTypeFilter}
        onNavigate={onNavigate}
      />

      <Separator />

      <OrganizeSection
        isOpen={isOpen("organize")}
        onOpenChange={toggleSection("organize")}
        t={t}
        canCreateFolder={vaultContext.type !== "org" || selectedOrgCanManageFolders}
        folders={selectedFolders}
        activeFolderId={selectedFolderId}
        linkHref={(id) =>
          vaultContext.type === "org"
            ? `/dashboard/teams/${scopedTeamId}?folder=${id}`
            : `/dashboard/folders/${id}`
        }
        showFolderMenu={vaultContext.type === "org" ? selectedOrgCanManageFolders : true}
        tags={selectedTags}
        activeTagId={selectedTagId}
        tagHref={(id) =>
          vaultContext.type === "org"
            ? `/dashboard/teams/${scopedTeamId}?tag=${id}`
            : `/dashboard/tags/${id}`
        }
        onCreateFolder={() =>
          vaultContext.type === "org"
            ? onCreateFolder(scopedTeamId)
            : onCreateFolder()
        }
        onCreateTag={() =>
          vaultContext.type === "org"
            ? onCreateTag(scopedTeamId)
            : onCreateTag()
        }
        canCreateTag={vaultContext.type !== "org" || selectedOrgCanManageTags}
        onEditFolder={(f) =>
          vaultContext.type === "org"
            ? onEditFolder(f, scopedTeamId)
            : onEditFolder(f)
        }
        onDeleteFolder={(f) =>
          vaultContext.type === "org"
            ? onDeleteFolder(f, scopedTeamId)
            : onDeleteFolder(f)
        }
        onEditTag={(tag) =>
          vaultContext.type === "org"
            ? onEditTag(tag, scopedTeamId)
            : onEditTag(tag)
        }
        onDeleteTag={(tag) =>
          vaultContext.type === "org"
            ? onDeleteTag(tag, scopedTeamId)
            : onDeleteTag(tag)
        }
        showTagMenu={vaultContext.type !== "org" || selectedOrgCanManageTags}
        onNavigate={onNavigate}
      />

      <Separator />

      <VaultManagementSection
        t={t}
        vaultContext={vaultContext}
        isSelectedVaultArchive={isSelectedVaultArchive}
        isSelectedVaultTrash={isSelectedVaultTrash}
        isShareLinks={isShareLinks}
        isPersonalAuditLog={isPersonalAuditLog}
        activeAuditOrgId={activeAuditOrgId}
        onNavigate={onNavigate}
      />

      <Separator />

      <SecuritySection
        isOpen={isOpen("security")}
        onOpenChange={toggleSection("security")}
        t={t}
        isWatchtower={isWatchtower}
        isEmergencyAccess={isEmergencyAccess}
        onNavigate={onNavigate}
      />

      <Separator />

      <UtilitiesSection
        isOpen={isOpen("utilities")}
        onOpenChange={toggleSection("utilities")}
        t={t}
        tOrg={tOrg}
        selectedOrg={selectedOrg}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
