"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { Separator } from "@/components/ui/separator";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { FolderDialog } from "@/components/folders/folder-dialog";
import { VaultSelector } from "@/components/layout/vault-selector";
import { SecuritySection, UtilitiesSection } from "@/components/layout/sidebar-section-security";
import { type SidebarFolderItem } from "@/components/layout/sidebar-shared";
import { VaultSection, CategoriesSection, OrganizationsSection, OrganizeSection } from "@/components/layout/sidebar-sections";
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
import { ORG_ROLE, API_PATH, apiPath } from "@/lib/constants";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { toast } from "sonner";
import { useVaultContext } from "@/hooks/use-vault-context";

// ─── Section keys ────────────────────────────────────────────────

type SidebarSection = "vault" | "categories" | "organizations" | "organize" | "security" | "utilities";

const COLLAPSE_DEFAULTS: Record<SidebarSection, boolean> = {
  vault: false,         // open
  categories: true,     // closed
  organizations: false, // open
  organize: true,       // closed
  security: false,      // open
  utilities: true,      // closed
};

// ─── Interfaces ──────────────────────────────────────────────────

interface TagItem {
  id: string;
  name: string;
  color: string | null;
  passwordCount: number;
}

interface OrgTagGroup {
  orgId: string;
  orgName: string;
  tags: { id: string; name: string; color: string | null; count: number }[];
}

interface OrgFolderGroup {
  orgId: string;
  orgName: string;
  orgRole: string;
  folders: FolderItem[];
}

type FolderItem = SidebarFolderItem;

interface OrgItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

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
  const [tags, setTags] = useState<TagItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [orgTagGroups, setOrgTagGroups] = useState<OrgTagGroup[]>([]);
  const [orgFolderGroups, setOrgFolderGroups] = useState<OrgFolderGroup[]>([]);

  // Folder dialog state (personal + org)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<FolderItem | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<FolderItem | null>(null);
  // When non-null, the folder dialog/delete dialog operates on an org's folders
  const [folderOrgId, setFolderOrgId] = useState<string | null>(null);

  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Strip locale prefix for route matching
  const cleanPath = stripLocalePrefix(pathname);

  // Active state detection (all path-based)
  const activeTypeFilter = cleanPath === "/dashboard" ? searchParams.get("type") : null;
  const isVaultAll = cleanPath === "/dashboard" && !activeTypeFilter;
  const isVaultFavorites = cleanPath === "/dashboard/favorites";
  const isVaultArchive = cleanPath === "/dashboard/archive";
  const isVaultTrash = cleanPath === "/dashboard/trash";
  const isWatchtower = cleanPath === "/dashboard/watchtower";
  const isAuditLog = cleanPath === "/dashboard/audit-logs" || cleanPath.endsWith("/audit-logs");
  const isPersonalAuditLog = cleanPath === "/dashboard/audit-logs";
  const auditOrgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)\/audit-logs$/);
  const activeAuditOrgId = auditOrgMatch ? auditOrgMatch[1] : null;
  const tagMatch = cleanPath.match(/^\/dashboard\/tags\/([^/]+)/);
  const activeTagId = tagMatch ? tagMatch[1] : null;
  const folderMatch = cleanPath.match(/^\/dashboard\/folders\/([^/]+)/);
  const activeFolderId = folderMatch ? folderMatch[1] : null;
  const orgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)/);
  const activeOrgId = orgMatch && !isAuditLog ? orgMatch[1] : null;
  const activeOrgTagId = activeOrgId ? searchParams.get("tag") : null;
  const activeOrgFolderId = activeOrgId ? searchParams.get("folder") : null;
  const activeOrgTypeFilter = activeOrgId ? searchParams.get("type") : null;
  const activeOrgScope = activeOrgId ? searchParams.get("scope") : null;
  const isOrgsManage = cleanPath === "/dashboard/orgs";
  const isShareLinks = cleanPath === "/dashboard/share-links";
  const isEmergencyAccess = cleanPath === "/dashboard/emergency-access" || cleanPath.startsWith("/dashboard/emergency-access/");
  const vaultContext = useVaultContext(orgs);
  const selectedOrgId = vaultContext.type === "org" ? vaultContext.orgId : null;
  const selectedOrg = selectedOrgId ? orgs.find((org) => org.id === selectedOrgId) ?? null : null;
  const selectedOrgFolderGroup = selectedOrgId
    ? orgFolderGroups.find((group) => group.orgId === selectedOrgId)
    : null;
  const selectedOrgTagGroup = selectedOrgId
    ? orgTagGroups.find((group) => group.orgId === selectedOrgId)
    : null;
  const selectedOrgCanManageFolders = selectedOrg
    ? selectedOrg.role === ORG_ROLE.OWNER || selectedOrg.role === ORG_ROLE.ADMIN
    : false;
  const selectedOrgTypeFilter = selectedOrgId && activeOrgId === selectedOrgId ? activeOrgTypeFilter : null;
  const selectedOrgScope = selectedOrgId && activeOrgId === selectedOrgId ? activeOrgScope : null;
  const selectedOrgFolderId = selectedOrgId && activeOrgId === selectedOrgId ? activeOrgFolderId : null;
  const selectedOrgTagId = selectedOrgId && activeOrgId === selectedOrgId ? activeOrgTagId : null;

  const selectedTypeFilter = vaultContext.type === "org" ? selectedOrgTypeFilter : activeTypeFilter;
  const selectedFolderId = vaultContext.type === "org" ? selectedOrgFolderId : activeFolderId;
  const selectedTagId = vaultContext.type === "org" ? selectedOrgTagId : activeTagId;

  const isSelectedVaultAll = vaultContext.type === "org"
    ? activeOrgId === selectedOrgId &&
      !selectedOrgTypeFilter &&
      !selectedOrgScope &&
      !selectedOrgTagId &&
      !selectedOrgFolderId
    : isVaultAll;
  const isSelectedVaultFavorites = vaultContext.type === "org"
    ? activeOrgId === selectedOrgId && selectedOrgScope === "favorites"
    : isVaultFavorites;
  const isSelectedVaultArchive = vaultContext.type === "org"
    ? activeOrgId === selectedOrgId && selectedOrgScope === "archive"
    : isVaultArchive;
  const isSelectedVaultTrash = vaultContext.type === "org"
    ? activeOrgId === selectedOrgId && selectedOrgScope === "trash"
    : isVaultTrash;

  const selectedFolders = vaultContext.type === "org"
    ? selectedOrgFolderGroup?.folders ?? []
    : folders;
  const selectedTags = vaultContext.type === "org"
    ? selectedOrgTagGroup?.tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        count: tag.count,
      })) ?? []
    : tags
        .filter((tag) => tag.passwordCount > 0)
        .map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          count: tag.passwordCount,
        }));

  const handleVaultChange = (value: string) => {
    if (value === "personal") {
      router.push("/dashboard");
      onOpenChange(false);
      return;
    }
    router.push(`/dashboard/orgs/${value}`);
    onOpenChange(false);
  };

  // ─── Collapsible state ──────────────────────────────────────────

  const [collapsed, setCollapsed] = useLocalStorage<Record<SidebarSection, boolean>>(
    "sidebar-collapsed",
    COLLAPSE_DEFAULTS
  );

  const isOpen = (k: SidebarSection) => !collapsed[k];

  const toggleSection = (k: SidebarSection) => (open: boolean) =>
    setCollapsed((prev) => ({ ...prev, [k]: !open }));

  // Auto-expand section when navigating to a route within it.
  // One-time per navigation — user can manually close afterward.
  useEffect(() => {
    const toOpen: SidebarSection[] = [];
    if (isSelectedVaultAll || isSelectedVaultFavorites || isSelectedVaultArchive || isSelectedVaultTrash) toOpen.push("vault");
    if (selectedTypeFilter !== null) toOpen.push("categories");
    if (activeOrgId !== null || isOrgsManage) toOpen.push("organizations");
    if (selectedTagId !== null || selectedFolderId !== null) toOpen.push("organize");
    if (isWatchtower || isShareLinks || isEmergencyAccess || isAuditLog) toOpen.push("security");

    if (toOpen.length > 0) {
      setCollapsed((prev) => {
        const next = { ...prev };
        for (const k of toOpen) next[k] = false;
        return next;
      });
    }
  }, [pathname, searchParams, isSelectedVaultAll, isSelectedVaultFavorites, isSelectedVaultArchive, isSelectedVaultTrash, selectedTypeFilter, selectedTagId, selectedFolderId, activeOrgId, isOrgsManage, isWatchtower, isShareLinks, isEmergencyAccess, isAuditLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Data fetching ──────────────────────────────────────────────

  const fetchData = () => {
    fetch(API_PATH.TAGS)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch tags");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setTags(data);
      })
      .catch(() => {});

    fetch(API_PATH.FOLDERS)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch folders");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setFolders(data);
      })
      .catch(() => {});

    fetch(API_PATH.ORGS)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch orgs");
        return res.json();
      })
      .then(async (data) => {
        if (!Array.isArray(data)) return;
        setOrgs(data);

        // Fetch tags and folders for all orgs in parallel
        const tagGroups: OrgTagGroup[] = [];
        const folderGroups: OrgFolderGroup[] = [];
        await Promise.all(
          data.map(async (org: OrgItem) => {
            const [tagsRes, foldersRes] = await Promise.all([
              fetch(apiPath.orgTags(org.id)).catch(() => null),
              fetch(apiPath.orgFolders(org.id)).catch(() => null),
            ]);
            if (tagsRes?.ok) {
              const tags = await tagsRes.json();
              if (Array.isArray(tags) && tags.length > 0) {
                tagGroups.push({ orgId: org.id, orgName: org.name, tags });
              }
            }
            if (foldersRes?.ok) {
              const folders = await foldersRes.json();
              if (Array.isArray(folders)) {
                const canManage = org.role === ORG_ROLE.OWNER || org.role === ORG_ROLE.ADMIN;
                if (folders.length > 0 || canManage) {
                  folderGroups.push({ orgId: org.id, orgName: org.name, orgRole: org.role, folders });
                }
              }
            }
          })
        );
        setOrgTagGroups(tagGroups);
        setOrgFolderGroups(folderGroups);
      })
      .catch(() => {});
  };

  // Fetch data on mount and when pathname changes
  useEffect(() => {
    fetchData();
  }, [pathname]);

  // Listen for data-changed events (import, create, etc.)
  useEffect(() => {
    const handler = () => fetchData();
    window.addEventListener("vault-data-changed", handler);
    window.addEventListener("org-data-changed", handler);
    return () => {
      window.removeEventListener("vault-data-changed", handler);
      window.removeEventListener("org-data-changed", handler);
    };
  }, []);

  const handleImportComplete = () => {
    window.dispatchEvent(new CustomEvent("vault-data-changed"));
  };

  // ─── Folder CRUD handlers (personal + org) ──────────────────────

  const handleFolderCreate = (orgId?: string) => {
    setFolderOrgId(orgId ?? null);
    setEditingFolder(null);
    setFolderDialogOpen(true);
  };

  const handleFolderEdit = (folder: FolderItem, orgId?: string) => {
    setFolderOrgId(orgId ?? null);
    setEditingFolder(folder);
    setFolderDialogOpen(true);
  };

  const handleFolderDeleteClick = (folder: FolderItem, orgId?: string) => {
    setFolderOrgId(orgId ?? null);
    setDeletingFolder(folder);
  };

  const showApiError = async (res: Response) => {
    try {
      const json = await res.json();
      const i18nKey = apiErrorToI18nKey(json.error);
      toast.error(tErrors(i18nKey));
    } catch {
      toast.error(tErrors("unknownError"));
    }
  };

  const handleFolderSubmit = async (data: { name: string; parentId: string | null }) => {
    const isOrg = folderOrgId !== null;
    const url = editingFolder
      ? isOrg
        ? apiPath.orgFolderById(folderOrgId!, editingFolder.id)
        : apiPath.folderById(editingFolder.id)
      : isOrg
        ? apiPath.orgFolders(folderOrgId!)
        : API_PATH.FOLDERS;
    const method = editingFolder ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      await showApiError(res);
      throw new Error("API error"); // propagate to keep dialog open
    }
    fetchData();
  };

  const handleFolderDelete = async () => {
    if (!deletingFolder) return;
    const url = folderOrgId
      ? apiPath.orgFolderById(folderOrgId, deletingFolder.id)
      : apiPath.folderById(deletingFolder.id);
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      await showApiError(res);
      setDeletingFolder(null);
      return;
    }
    setDeletingFolder(null);
    fetchData();
  };

  /** Get the folder list for the current dialog context (personal or org). */
  const dialogFolders = folderOrgId
    ? orgFolderGroups.find((g) => g.orgId === folderOrgId)?.folders ?? []
    : folders;

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
        onOpenChange={(open) => { if (!open) setDeletingFolder(null); }}
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
