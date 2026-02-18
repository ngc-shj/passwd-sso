"use client";

import { Separator } from "@/components/ui/separator";
import { VaultSelector } from "@/components/layout/vault-selector";
import { SecuritySection, UtilitiesSection } from "@/components/layout/sidebar-section-security";
import {
  VaultSection,
  CategoriesSection,
  OrganizationsSection,
  OrganizeSection,
} from "@/components/layout/sidebar-sections";
import type { SidebarSection } from "@/hooks/use-sidebar-sections-state";
import type { SidebarFolderItem, SidebarOrgItem } from "@/hooks/use-sidebar-data";
import type { VaultContext } from "@/hooks/use-vault-context";

interface OrganizeTagItem {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

export interface SidebarContentProps {
  t: (key: string) => string;
  tOrg: (key: string) => string;
  vaultContext: VaultContext;
  orgs: SidebarOrgItem[];
  selectedOrg: SidebarOrgItem | null;
  selectedOrgId: string | null;
  selectedOrgCanManageFolders: boolean;
  selectedTypeFilter: string | null;
  selectedFolderId: string | null;
  selectedTagId: string | null;
  isSelectedVaultAll: boolean;
  isSelectedVaultFavorites: boolean;
  isSelectedVaultArchive: boolean;
  isSelectedVaultTrash: boolean;
  isOrgsManage: boolean;
  isWatchtower: boolean;
  isShareLinks: boolean;
  isEmergencyAccess: boolean;
  isPersonalAuditLog: boolean;
  activeAuditOrgId: string | null;
  selectedFolders: SidebarFolderItem[];
  selectedTags: OrganizeTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  onVaultChange: (value: string) => void;
  onCreateFolder: (orgId?: string) => void;
  onEditFolder: (folder: SidebarFolderItem, orgId?: string) => void;
  onDeleteFolder: (folder: SidebarFolderItem, orgId?: string) => void;
  onImportComplete: () => void;
  onNavigate: () => void;
}

export function SidebarContent({
  t,
  tOrg,
  vaultContext,
  orgs,
  selectedOrg,
  selectedOrgId,
  selectedOrgCanManageFolders,
  selectedTypeFilter,
  selectedFolderId,
  selectedTagId,
  isSelectedVaultAll,
  isSelectedVaultFavorites,
  isSelectedVaultArchive,
  isSelectedVaultTrash,
  isOrgsManage,
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
  onEditFolder,
  onDeleteFolder,
  onImportComplete,
  onNavigate,
}: SidebarContentProps) {
  return (
    <nav className="space-y-4 p-4">
      <VaultSelector
        value={vaultContext.type === "org" ? vaultContext.orgId : "personal"}
        orgs={orgs}
        onValueChange={onVaultChange}
      />

      <VaultSection
        isOpen={isOpen("vault")}
        onOpenChange={toggleSection("vault")}
        t={t}
        vaultContext={vaultContext}
        selectedOrgName={selectedOrg?.name}
        isSelectedVaultAll={isSelectedVaultAll}
        isSelectedVaultFavorites={isSelectedVaultFavorites}
        isSelectedVaultArchive={isSelectedVaultArchive}
        isSelectedVaultTrash={isSelectedVaultTrash}
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

      <OrganizationsSection
        isOpen={isOpen("organizations")}
        onOpenChange={toggleSection("organizations")}
        tOrg={tOrg}
        orgs={orgs}
        selectedOrgId={selectedOrgId}
        isOrgsManage={isOrgsManage}
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
            ? `/dashboard/orgs/${vaultContext.orgId}?folder=${id}`
            : `/dashboard/folders/${id}`
        }
        showFolderMenu={vaultContext.type === "org" ? selectedOrgCanManageFolders : true}
        tags={selectedTags}
        activeTagId={selectedTagId}
        tagHref={(id) =>
          vaultContext.type === "org"
            ? `/dashboard/orgs/${vaultContext.orgId}?tag=${id}`
            : `/dashboard/tags/${id}`
        }
        onCreateFolder={() =>
          vaultContext.type === "org"
            ? onCreateFolder(vaultContext.orgId)
            : onCreateFolder()
        }
        onEditFolder={(f) =>
          vaultContext.type === "org"
            ? onEditFolder(f, vaultContext.orgId)
            : onEditFolder(f)
        }
        onDeleteFolder={(f) =>
          vaultContext.type === "org"
            ? onDeleteFolder(f, vaultContext.orgId)
            : onDeleteFolder(f)
        }
        onNavigate={onNavigate}
      />

      <Separator />

      <SecuritySection
        isOpen={isOpen("security")}
        onOpenChange={toggleSection("security")}
        t={t}
        isWatchtower={isWatchtower}
        isShareLinks={isShareLinks}
        isEmergencyAccess={isEmergencyAccess}
        isPersonalAuditLog={isPersonalAuditLog}
        activeAuditOrgId={activeAuditOrgId}
        orgs={orgs}
        onNavigate={onNavigate}
      />

      <Separator />

      <UtilitiesSection
        isOpen={isOpen("utilities")}
        onOpenChange={toggleSection("utilities")}
        t={t}
        tOrg={tOrg}
        selectedOrg={selectedOrg}
        onImportComplete={onImportComplete}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
