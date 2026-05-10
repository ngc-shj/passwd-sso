"use client";


import { VaultSelector } from "@/components/layout/vault-selector";
import { InsightsSection, SettingsNavSection, ToolsSection } from "@/components/layout/sidebar-section-security";
import {
  VaultSection,
  CategoriesSection,
  FoldersSection,
  TagsSection,
  VaultManagementSection,
} from "@/components/layout/sidebar-sections";
import type { SidebarSection } from "@/hooks/sidebar/use-sidebar-sections-state";
import type {
  SidebarFolderItem,
  SidebarTeamItem,
  SidebarTeamTagItem,
} from "@/hooks/sidebar/use-sidebar-data";
import type { VaultContext } from "@/hooks/vault/use-vault-context";
import { TEAM_ROLE, isTeamAdminRole } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { HeartPulse } from "lucide-react";

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
  isAdminActive?: boolean;
  isSettingsActive: boolean;
  isExportActive: boolean;
  isImportActive: boolean;
  isAdmin: boolean;
  isTenantAdmin: boolean;
  isWatchtower: boolean;
  isShareLinks: boolean;
  isEmergencyAccess: boolean;
  isPersonalAuditLog: boolean;
  selectedFolders: SidebarFolderItem[];
  selectedTags: SidebarTeamTagItem[];
  isOpen: (key: SidebarSection) => boolean;
  toggleSection: (key: SidebarSection) => (open: boolean) => void;
  onVaultChange: (value: string) => void;
  onCreateFolder: (teamId?: string) => void;
  onEditFolder: (folder: SidebarFolderItem, teamId?: string) => void;
  onDeleteFolder: (folder: SidebarFolderItem, teamId?: string) => void;
  onEditTag: (tag: SidebarTeamTagItem, teamId?: string) => void;
  onDeleteTag: (tag: SidebarTeamTagItem, teamId?: string) => void;
  onNavigate: () => void;
}

// Pick the destination of the sidebar "Admin Console" link based on the
// active vault scope and the user's admin reach:
//
//   - team vault                    → that team's admin home
//   - personal + tenant admin       → tenant admin home
//   - personal + team-only admin    → first admin team's home (sending
//                                     team-only admins to /admin/tenant/*
//                                     would 404)
//   - fallback                      → tenant admin home; reachable only if
//                                     the caller renders the link without
//                                     `isAdmin` gating (sidebar.tsx prevents
//                                     this — kept defensively).
function resolveAdminConsoleHref(args: {
  vaultContext: VaultContext;
  isTenantAdmin: boolean;
  teams: SidebarTeamItem[];
}): string {
  const { vaultContext, isTenantAdmin, teams } = args;
  if (vaultContext.type === "team") {
    return `/admin/teams/${vaultContext.teamId}/general`;
  }
  if (isTenantAdmin) {
    return "/admin/tenant/members";
  }
  const firstAdminTeamId = teams.find((team) => isTeamAdminRole(team.role))?.id;
  if (firstAdminTeamId) {
    return `/admin/teams/${firstAdminTeamId}/general`;
  }
  return "/admin/tenant/members";
}

export function SidebarContent({
  t,
  tTeam: _tTeam,
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
  isAdminActive,
  isSettingsActive,
  isExportActive,
  isImportActive,
  isAdmin,
  isTenantAdmin,
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isPersonalAuditLog,
  selectedFolders,
  selectedTags,
  isOpen,
  toggleSection,
  onVaultChange,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
  onEditTag,
  onDeleteTag,
  onNavigate,
}: SidebarContentProps) {
  const teamItems = teams;
  const scopedTeamId =
    vaultContext.type === "team" ? (vaultContext.teamId) : "";
  const adminConsoleHref = resolveAdminConsoleHref({
    vaultContext,
    isTenantAdmin,
    teams,
  });
  return (
    <nav className="space-y-2 p-4">
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

      <FoldersSection
        isOpen={isOpen("folders")}
        onOpenChange={toggleSection("folders")}
        t={t}
        canCreate={vaultContext.type !== "team" || selectedTeamCanManageFolders}
        folders={selectedFolders}
        activeFolderId={selectedFolderId}
        linkHref={(id) =>
          vaultContext.type === "team"
            ? `/dashboard/teams/${scopedTeamId}?folder=${id}`
            : `/dashboard/folders/${id}`
        }
        showMenu={vaultContext.type === "team" ? selectedTeamCanManageFolders : true}
        onCreate={() =>
          vaultContext.type === "team"
            ? onCreateFolder(scopedTeamId)
            : onCreateFolder()
        }
        onEdit={(f) =>
          vaultContext.type === "team"
            ? onEditFolder(f, scopedTeamId)
            : onEditFolder(f)
        }
        onDelete={(f) =>
          vaultContext.type === "team"
            ? onDeleteFolder(f, scopedTeamId)
            : onDeleteFolder(f)
        }
        onNavigate={onNavigate}
      />

      <TagsSection
        isOpen={isOpen("tags")}
        onOpenChange={toggleSection("tags")}
        t={t}
        tags={selectedTags}
        activeTagId={selectedTagId}
        tagHref={(id) =>
          vaultContext.type === "team"
            ? `/dashboard/teams/${scopedTeamId}?tag=${id}`
            : `/dashboard/tags/${id}`
        }
        showMenu={vaultContext.type !== "team" || selectedTeamCanManageTags}
        onEdit={(tag) =>
          vaultContext.type === "team"
            ? onEditTag(tag, scopedTeamId)
            : onEditTag(tag)
        }
        onDelete={(tag) =>
          vaultContext.type === "team"
            ? onDeleteTag(tag, scopedTeamId)
            : onDeleteTag(tag)
        }
        onNavigate={onNavigate}
      />

      <VaultManagementSection
        t={t}
        vaultContext={vaultContext}
        isSelectedVaultArchive={isSelectedVaultArchive}
        isSelectedVaultTrash={isSelectedVaultTrash}
        isShareLinks={isShareLinks}
        onNavigate={onNavigate}
      />

      {vaultContext.type !== "team" && (
        <Button
          variant={isEmergencyAccess ? "secondary" : "ghost"}
          className="w-full justify-start gap-2"
          asChild
        >
          <Link href="/dashboard/emergency-access" onClick={onNavigate}>
            <HeartPulse className="h-4 w-4" />
            {t("emergencyAccess")}
          </Link>
        </Button>
      )}

      {!(vaultContext.type === "team" && vaultContext.teamRole === TEAM_ROLE.VIEWER) && (
        <InsightsSection
          isOpen={isOpen("security")}
          onOpenChange={toggleSection("security")}
          t={t}
          vaultContext={vaultContext}
          isWatchtower={isWatchtower}
          isPersonalAuditLog={isPersonalAuditLog}
          onNavigate={onNavigate}
        />
      )}

      <SettingsNavSection
        isOpen={isOpen("settingsNav")}
        onOpenChange={toggleSection("settingsNav")}
        t={t}
        selectedTeam={selectedTeam}
        adminConsoleHref={adminConsoleHref}
        isAdminActive={isAdminActive}
        isSettingsActive={isSettingsActive}
        isAdmin={isAdmin}
        onNavigate={onNavigate}
      />

      <ToolsSection
        isOpen={isOpen("tools")}
        onOpenChange={toggleSection("tools")}
        t={t}
        selectedTeam={selectedTeam}
        isExportActive={isExportActive}
        isImportActive={isImportActive}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
