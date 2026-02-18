"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { Separator } from "@/components/ui/separator";
import { FolderDialog } from "@/components/folders/folder-dialog";
import { VaultSelector } from "@/components/layout/vault-selector";
import { SecuritySection, UtilitiesSection } from "@/components/layout/sidebar-section-security";
import { VaultSection, CategoriesSection, OrganizationsSection, OrganizeSection } from "@/components/layout/sidebar-sections";
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

  // ─── Content ────────────────────────────────────────────────────

  const content = (
    <nav className="space-y-4 p-4">
      <VaultSelector
        value={vaultContext.type === "org" ? vaultContext.orgId : "personal"}
        orgs={orgs}
        onValueChange={handleVaultChange}
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
        onNavigate={() => onOpenChange(false)}
      />

      <CategoriesSection
        isOpen={isOpen("categories")}
        onOpenChange={toggleSection("categories")}
        t={t}
        vaultContext={vaultContext}
        selectedTypeFilter={selectedTypeFilter}
        onNavigate={() => onOpenChange(false)}
      />

      <OrganizationsSection
        isOpen={isOpen("organizations")}
        onOpenChange={toggleSection("organizations")}
        tOrg={tOrg}
        orgs={orgs}
        selectedOrgId={selectedOrgId}
        isOrgsManage={isOrgsManage}
        onNavigate={() => onOpenChange(false)}
      />

      {/* ── Organize (folders + tags) ──────────────────────── */}
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
            ? handleFolderCreate(vaultContext.orgId)
            : handleFolderCreate()
        }
        onEditFolder={(f) =>
          vaultContext.type === "org"
            ? handleFolderEdit(f, vaultContext.orgId)
            : handleFolderEdit(f)
        }
        onDeleteFolder={(f) =>
          vaultContext.type === "org"
            ? handleFolderDeleteClick(f, vaultContext.orgId)
            : handleFolderDeleteClick(f)
        }
        onNavigate={() => onOpenChange(false)}
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
        onNavigate={() => onOpenChange(false)}
      />

      <Separator />

      <UtilitiesSection
        isOpen={isOpen("utilities")}
        onOpenChange={toggleSection("utilities")}
        t={t}
        tOrg={tOrg}
        selectedOrg={selectedOrg}
        onImportComplete={handleImportComplete}
        onNavigate={() => onOpenChange(false)}
      />
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-56 border-r bg-background shrink-0 overflow-auto">
        {content}
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-56 p-0">
          <VisuallyHidden.Root>
            <SheetTitle>{t("sidebar")}</SheetTitle>
          </VisuallyHidden.Root>
          {content}
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
