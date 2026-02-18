"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { FolderDialog } from "@/components/folders/folder-dialog";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { useSidebarData } from "@/hooks/use-sidebar-data";
import { useSidebarFolderCrud } from "@/hooks/use-sidebar-folder-crud";
import { useSidebarNavigationState } from "@/hooks/use-sidebar-navigation-state";
import { useSidebarSectionsState } from "@/hooks/use-sidebar-sections-state";
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
import { useVaultContext } from "@/hooks/use-vault-context";

interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Component ───────────────────────────────────────────────────

export function Sidebar({ open, onOpenChange }: SidebarProps) {
  const router = useRouter();
  const t = useTranslations("Dashboard");
  const tCommon = useTranslations("Common");
  const tOrg = useTranslations("Org");
  const tErrors = useTranslations("ApiErrors");

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { tags, folders, orgs, orgTagGroups, orgFolderGroups, refreshData, notifyDataChanged } =
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
    orgFolderGroups,
    refreshData,
    tErrors,
  });

  const vaultContext = useVaultContext(orgs);
  const {
    activeOrgId,
    activeAuditOrgId,
    isOrgsManage,
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isAuditLog,
    isPersonalAuditLog,
    selectedOrgId,
    selectedOrg,
    selectedOrgCanManageFolders,
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
    orgs,
    folders,
    tags,
    orgFolderGroups,
    orgTagGroups,
  });

  const handleVaultChange = (value: string) => {
    if (value === "personal") {
      router.push("/dashboard");
      onOpenChange(false);
      return;
    }
    router.push(`/dashboard/orgs/${value}`);
    onOpenChange(false);
  };

  const { isOpen, toggleSection } = useSidebarSectionsState({
    routeKey: `${pathname}?${searchParams.toString()}`,
    isSelectedVaultAll,
    isSelectedVaultFavorites,
    isSelectedVaultArchive,
    isSelectedVaultTrash,
    selectedTypeFilter,
    selectedTagId,
    selectedFolderId,
    activeOrgId,
    isOrgsManage,
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isAuditLog,
  });

  const handleImportComplete = () => {
    notifyDataChanged();
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-56 border-r bg-background shrink-0 overflow-auto">
        <SidebarContent
          t={t}
          tOrg={tOrg}
          vaultContext={vaultContext}
          orgs={orgs}
          selectedOrg={selectedOrg}
          selectedOrgId={selectedOrgId}
          selectedOrgCanManageFolders={selectedOrgCanManageFolders}
          selectedTypeFilter={selectedTypeFilter}
          selectedFolderId={selectedFolderId}
          selectedTagId={selectedTagId}
          isSelectedVaultAll={isSelectedVaultAll}
          isSelectedVaultFavorites={isSelectedVaultFavorites}
          isSelectedVaultArchive={isSelectedVaultArchive}
          isSelectedVaultTrash={isSelectedVaultTrash}
          isOrgsManage={isOrgsManage}
          isWatchtower={isWatchtower}
          isShareLinks={isShareLinks}
          isEmergencyAccess={isEmergencyAccess}
          isPersonalAuditLog={isPersonalAuditLog}
          activeAuditOrgId={activeAuditOrgId}
          selectedFolders={selectedFolders}
          selectedTags={selectedTags}
          isOpen={isOpen}
          toggleSection={toggleSection}
          onVaultChange={handleVaultChange}
          onCreateFolder={handleFolderCreate}
          onEditFolder={handleFolderEdit}
          onDeleteFolder={handleFolderDeleteClick}
          onImportComplete={handleImportComplete}
          onNavigate={() => onOpenChange(false)}
        />
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-56 p-0">
          <VisuallyHidden.Root>
            <SheetTitle>{t("sidebar")}</SheetTitle>
          </VisuallyHidden.Root>
          <SidebarContent
            t={t}
            tOrg={tOrg}
            vaultContext={vaultContext}
            orgs={orgs}
            selectedOrg={selectedOrg}
            selectedOrgId={selectedOrgId}
            selectedOrgCanManageFolders={selectedOrgCanManageFolders}
            selectedTypeFilter={selectedTypeFilter}
            selectedFolderId={selectedFolderId}
            selectedTagId={selectedTagId}
            isSelectedVaultAll={isSelectedVaultAll}
            isSelectedVaultFavorites={isSelectedVaultFavorites}
            isSelectedVaultArchive={isSelectedVaultArchive}
            isSelectedVaultTrash={isSelectedVaultTrash}
            isOrgsManage={isOrgsManage}
            isWatchtower={isWatchtower}
            isShareLinks={isShareLinks}
            isEmergencyAccess={isEmergencyAccess}
            isPersonalAuditLog={isPersonalAuditLog}
            activeAuditOrgId={activeAuditOrgId}
            selectedFolders={selectedFolders}
            selectedTags={selectedTags}
            isOpen={isOpen}
            toggleSection={toggleSection}
            onVaultChange={handleVaultChange}
            onCreateFolder={handleFolderCreate}
            onEditFolder={handleFolderEdit}
            onDeleteFolder={handleFolderDeleteClick}
            onImportComplete={handleImportComplete}
            onNavigate={() => onOpenChange(false)}
          />
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
    </>
  );
}
