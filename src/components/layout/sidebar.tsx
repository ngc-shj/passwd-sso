"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { FolderDialog } from "@/components/folders/folder-dialog";
import { TagDialog } from "@/components/tags/tag-dialog";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { useSidebarData } from "@/hooks/use-sidebar-data";
import { useSidebarFolderCrud } from "@/hooks/use-sidebar-folder-crud";
import { useSidebarTagCrud } from "@/hooks/use-sidebar-tag-crud";
import { useSidebarNavigationState } from "@/hooks/use-sidebar-navigation-state";
import { useSidebarSectionsState } from "@/hooks/use-sidebar-sections-state";
import { useSidebarViewModel } from "@/hooks/use-sidebar-view-model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTeamVaultContext } from "@/hooks/use-vault-context";
import { useSetActiveVault } from "@/lib/active-vault-context";

interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Component ───────────────────────────────────────────────────

export function Sidebar({ open, onOpenChange }: SidebarProps) {
  const router = useRouter();
  const t = useTranslations("Dashboard");
  const tCommon = useTranslations("Common");
  const tOrg = useTranslations("Team");
  const tErrors = useTranslations("ApiErrors");

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { tags, folders, teams, teamTagGroups, teamFolderGroups, refreshData } =
    useSidebarData(pathname);
  const {
    folderDialogOpen,
    setFolderDialogOpen,
    editingFolder,
    deletingFolder,
    dialogFolders,
    handleFolderCreate,
    handleFolderEdit,
    handleFolderDeleteClick,
    handleFolderSubmit,
    handleFolderDelete,
    clearDeletingFolder,
  } = useSidebarFolderCrud({
    folders,
    orgFolderGroups: teamFolderGroups.map((group) => ({
      orgId: group.teamId,
      orgName: group.teamName,
      orgRole: group.teamRole,
      folders: group.folders,
    })),
    refreshData,
    tErrors,
  });
  const {
    tagDialogOpen,
    setTagDialogOpen,
    editingTag,
    deletingTag,
    handleTagCreate,
    handleTagEdit,
    handleTagDeleteClick,
    handleTagSubmit,
    handleTagDelete,
    clearDeletingTag,
  } = useSidebarTagCrud({
    refreshData,
    tErrors,
  });

  const vaultContext = useTeamVaultContext(teams);
  const setActiveVault = useSetActiveVault();
  useEffect(() => {
    setActiveVault(vaultContext);
  }, [vaultContext, setActiveVault]);
  const {
    activeAuditTeamId,
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isAuditLog,
    isPersonalAuditLog,
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
  } = useSidebarNavigationState({
    pathname,
    searchParams,
    vaultContext,
    orgs: teams,
    folders,
    tags,
    orgFolderGroups: teamFolderGroups.map((group) => ({
      orgId: group.teamId,
      orgName: group.teamName,
      orgRole: group.teamRole,
      folders: group.folders,
    })),
    orgTagGroups: teamTagGroups.map((group) => ({
      orgId: group.teamId,
      orgName: group.teamName,
      tags: group.tags,
    })),
  });

  const { isOpen, toggleSection } = useSidebarSectionsState({
    routeKey: `${pathname}?${searchParams.toString()}`,
    selectedTypeFilter,
    selectedTagId,
    selectedFolderId,
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isAuditLog,
  });

  const sidebarContentProps = useSidebarViewModel({
    t,
    tOrg,
    router,
    onOpenChange,
    vaultContext,
    orgs: teams,
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
  });

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-56 border-r bg-background shrink-0 overflow-auto">
        <SidebarContent {...sidebarContentProps} />
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-56 p-0">
          <VisuallyHidden.Root>
            <SheetTitle>{t("sidebar")}</SheetTitle>
          </VisuallyHidden.Root>
          <SidebarContent {...sidebarContentProps} />
        </SheetContent>
      </Sheet>

      {/* Folder create/edit dialog */}
      <FolderDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
        folders={dialogFolders}
        editFolder={editingFolder}
        onSubmit={handleFolderSubmit}
      />
      <TagDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        editTag={editingTag}
        onSubmit={handleTagSubmit}
      />

      {/* Folder delete confirmation */}
      <AlertDialog
        open={!!deletingFolder}
        onOpenChange={(open) => { if (!open) clearDeletingFolder(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteFolder")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("folderDeleteConfirm", { name: deletingFolder?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleFolderDelete}>
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Tag delete confirmation */}
      <AlertDialog
        open={!!deletingTag}
        onOpenChange={(open) => { if (!open) clearDeletingTag(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTag")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("tagDeleteConfirm", { name: deletingTag?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleTagDelete}>
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
