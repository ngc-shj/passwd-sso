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
  SidebarTeamItem,
  SidebarOrganizeTagItem,
} from "@/hooks/use-sidebar-data";
import type { VaultContext } from "@/hooks/use-vault-context";

export interface SidebarContentProps {
  t: (key: string) => string;
  tTeam: (key: string) => string;
  vaultContext: VaultContext;
  teams: SidebarTeamItem[];
  selectedTeam: SidebarTeamItem | null;
  selectedTeamCanManageFolders: boolean;
  selectedTeamCanManageTags: boolean;
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
  selectedTags: SidebarOrganizeTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  onVaultChange: (value: string) => void;
  onCreateFolder: (teamId?: string) => void;
  onCreateTag: (teamId?: string) => void;
  onEditFolder: (folder: SidebarFolderItem, teamId?: string) => void;
  onDeleteFolder: (folder: SidebarFolderItem, teamId?: string) => void;
  onEditTag: (tag: SidebarOrganizeTagItem, teamId?: string) => void;
  onDeleteTag: (tag: SidebarOrganizeTagItem, teamId?: string) => void;
  onNavigate: () => void;
}

export function SidebarContent({
  t,
  tTeam,
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
  onVaultChange,
  onCreateFolder,
  onCreateTag,
  onEditFolder,
  onDeleteFolder,
  onEditTag,
  onDeleteTag,
  onNavigate,
}: SidebarContentProps) {
  const teamItems = teams;
  const scopedTeamId =
    vaultContext.type === "team" ? (vaultContext.teamId) : "";
  return (
    <nav className="space-y-4 p-4">
      <VaultSelector
        value={vaultContext.type === "team" ? scopedTeamId : "personal"}
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
        canCreateFolder={vaultContext.type !== "team" || selectedTeamCanManageFolders}
        folders={selectedFolders}
        activeFolderId={selectedFolderId}
        linkHref={(id) =>
          vaultContext.type === "team"
            ? `/dashboard/teams/${scopedTeamId}?folder=${id}`
            : `/dashboard/folders/${id}`
        }
        showFolderMenu={vaultContext.type === "team" ? selectedTeamCanManageFolders : true}
        tags={selectedTags}
        activeTagId={selectedTagId}
        tagHref={(id) =>
          vaultContext.type === "team"
            ? `/dashboard/teams/${scopedTeamId}?tag=${id}`
            : `/dashboard/tags/${id}`
        }
        onCreateFolder={() =>
          vaultContext.type === "team"
            ? onCreateFolder(scopedTeamId)
            : onCreateFolder()
        }
        onCreateTag={() =>
          vaultContext.type === "team"
            ? onCreateTag(scopedTeamId)
            : onCreateTag()
        }
        canCreateTag={vaultContext.type !== "team" || selectedTeamCanManageTags}
        onEditFolder={(f) =>
          vaultContext.type === "team"
            ? onEditFolder(f, scopedTeamId)
            : onEditFolder(f)
        }
        onDeleteFolder={(f) =>
          vaultContext.type === "team"
            ? onDeleteFolder(f, scopedTeamId)
            : onDeleteFolder(f)
        }
        onEditTag={(tag) =>
          vaultContext.type === "team"
            ? onEditTag(tag, scopedTeamId)
            : onEditTag(tag)
        }
        onDeleteTag={(tag) =>
          vaultContext.type === "team"
            ? onDeleteTag(tag, scopedTeamId)
            : onDeleteTag(tag)
        }
        showTagMenu={vaultContext.type !== "team" || selectedTeamCanManageTags}
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
        activeAuditTeamId={activeAuditTeamId}
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
        tTeam={tTeam}
        selectedTeam={selectedTeam}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
