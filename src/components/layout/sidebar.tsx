"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FolderOpen, Shield, Tag, Star, Archive, Trash2, Download, Upload, Building2, Settings, KeyRound, FileText, CreditCard, IdCard, Fingerprint, ScrollText, Link as LinkIcon, HeartPulse, ChevronDown, ChevronRight, Plus, Pencil, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { ExportDialog } from "@/components/passwords/export-dialog";
import { ImportDialog } from "@/components/passwords/import-dialog";
import { FolderDialog } from "@/components/folders/folder-dialog";
import { VaultSelector } from "@/components/layout/vault-selector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ORG_ROLE, ENTRY_TYPE, API_PATH, apiPath } from "@/lib/constants";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { toast } from "sonner";
import { useVaultContext, type VaultContext } from "@/hooks/use-vault-context";

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

interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  entryCount: number;
}

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

// ─── Folder tree helpers ────────────────────────────────────────

/** Check whether `folderId` is an ancestor of `targetId` in the flat list. */
function isAncestorOf(folderId: string, targetId: string, folders: FolderItem[]): boolean {
  const map = new Map(folders.map((f) => [f.id, f]));
  let current = map.get(targetId);
  while (current) {
    if (current.parentId === folderId) return true;
    current = current.parentId ? map.get(current.parentId) : undefined;
  }
  return false;
}

function FolderTreeNode({
  folder,
  folders,
  activeFolderId,
  depth,
  linkHref,
  showMenu,
  onNavigate,
  onEdit,
  onDelete,
}: {
  folder: FolderItem;
  folders: FolderItem[];
  activeFolderId: string | null;
  depth: number;
  /** Build the href for a folder link. */
  linkHref: (folderId: string) => string;
  /** Whether to show the edit/delete context menu (false for read-only members). */
  showMenu?: boolean;
  onNavigate: () => void;
  onEdit: (folder: FolderItem) => void;
  onDelete: (folder: FolderItem) => void;
}) {
  const tCommon = useTranslations("Common");
  const tDashboard = useTranslations("Dashboard");
  const children = folders.filter((f) => f.parentId === folder.id);
  const hasChildren = children.length > 0;

  // Auto-expand when the active folder is a descendant of this node.
  // Uses the "adjusting state during render" pattern recommended by React
  // to avoid useEffect + setState cascading renders.
  const isAncestorOfActive = activeFolderId
    ? isAncestorOf(folder.id, activeFolderId, folders)
    : false;
  const [open, setOpen] = useState(isAncestorOfActive);
  const [wasAncestor, setWasAncestor] = useState(isAncestorOfActive);
  if (isAncestorOfActive !== wasAncestor) {
    setWasAncestor(isAncestorOfActive);
    if (isAncestorOfActive) setOpen(true);
  }

  return (
    <>
      <div
        className="group/folder flex items-center"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="h-6 w-6 shrink-0 flex items-center justify-center rounded hover:bg-accent"
          >
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <Button
          variant={activeFolderId === folder.id ? "secondary" : "ghost"}
          className="flex-1 justify-start gap-2 min-w-0"
          asChild
        >
          <Link href={linkHref(folder.id)} onClick={onNavigate}>
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate">{folder.name}</span>
            {folder.entryCount > 0 && (
              <span className="ml-auto text-xs text-muted-foreground">
                {folder.entryCount}
              </span>
            )}
          </Link>
        </Button>
        {showMenu !== false && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 opacity-0 group-hover/folder:opacity-100 focus:opacity-100"
                aria-label={`${folder.name} menu`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(folder)}>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                {tCommon("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(folder)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                {tDashboard("deleteFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {hasChildren && open &&
        children.map((child) => (
          <FolderTreeNode
            key={child.id}
            folder={child}
            folders={folders}
            activeFolderId={activeFolderId}
            depth={depth + 1}
            linkHref={linkHref}
            showMenu={showMenu}
            onNavigate={onNavigate}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
    </>
  );
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

      {/* ── Organizations ──────────────────────────────────── */}
      <Collapsible open={isOpen("organizations")} onOpenChange={toggleSection("organizations")}>
        <CollapsibleSectionHeader
          icon={<Building2 className="h-3 w-3" />}
          isOpen={isOpen("organizations")}
        >
          {tOrg("organizations")}
        </CollapsibleSectionHeader>
        <CollapsibleContent>
          <div className="space-y-1">
            {orgs.map((org) => (
              <Button
                key={org.id}
                variant={selectedOrgId === org.id ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                asChild
              >
                <Link
                  href={`/dashboard/orgs/${org.id}`}
                  onClick={() => onOpenChange(false)}
                >
                  <Building2 className="h-4 w-4" />
                  <span className="truncate">{org.name}</span>
                </Link>
              </Button>
            ))}
            <Button
              variant={isOrgsManage ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/orgs" onClick={() => onOpenChange(false)}>
                <Settings className="h-4 w-4" />
                {tOrg("manage")}
              </Link>
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* ── Organize (folders + tags) ──────────────────────── */}
      <Separator />
      <Collapsible open={isOpen("organize")} onOpenChange={toggleSection("organize")}>
        <div className="flex items-center">
          <div className="flex-1">
            <CollapsibleSectionHeader
              icon={<Tag className="h-3 w-3" />}
              isOpen={isOpen("organize")}
            >
              {t("organize")}
            </CollapsibleSectionHeader>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 mr-1"
            onClick={() =>
              vaultContext.type === "org"
                ? handleFolderCreate(vaultContext.orgId)
                : handleFolderCreate()
            }
            disabled={vaultContext.type === "org" && !selectedOrgCanManageFolders}
            aria-label={t("createFolder")}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <CollapsibleContent>
          <div className="space-y-1 mb-2">
            {selectedFolders
              .filter((f) => !f.parentId)
              .map((folder) => (
                <FolderTreeNode
                  key={folder.id}
                  folder={folder}
                  folders={selectedFolders}
                  activeFolderId={selectedFolderId}
                  depth={0}
                  linkHref={(id) =>
                    vaultContext.type === "org"
                      ? `/dashboard/orgs/${vaultContext.orgId}?folder=${id}`
                      : `/dashboard/folders/${id}`
                  }
                  showMenu={vaultContext.type === "org" ? selectedOrgCanManageFolders : true}
                  onNavigate={() => onOpenChange(false)}
                  onEdit={(f) =>
                    vaultContext.type === "org"
                      ? handleFolderEdit(f, vaultContext.orgId)
                      : handleFolderEdit(f)
                  }
                  onDelete={(f) =>
                    vaultContext.type === "org"
                      ? handleFolderDeleteClick(f, vaultContext.orgId)
                      : handleFolderDeleteClick(f)
                  }
                />
              ))}
          </div>
          <div className="space-y-1">
            {selectedTags.map((tag) => {
              const colorClass = getTagColorClass(tag.color);
              return (
                <Button
                  key={tag.id}
                  variant={selectedTagId === tag.id ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2"
                  asChild
                >
                  <Link
                    href={
                      vaultContext.type === "org"
                        ? `/dashboard/orgs/${vaultContext.orgId}?tag=${tag.id}`
                        : `/dashboard/tags/${tag.id}`
                    }
                    onClick={() => onOpenChange(false)}
                  >
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-3 w-3 rounded-full p-0",
                        colorClass && "tag-color-bg",
                        colorClass
                      )}
                    />
                    {tag.name}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {tag.count}
                    </span>
                  </Link>
                </Button>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      {/* ── Security ───────────────────────────────────────── */}
      <Collapsible open={isOpen("security")} onOpenChange={toggleSection("security")}>
        <CollapsibleSectionHeader isOpen={isOpen("security")}>
          {t("security")}
        </CollapsibleSectionHeader>
        <CollapsibleContent>
          <div className="space-y-1">
            <Button
              variant={isWatchtower ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/watchtower" onClick={() => onOpenChange(false)}>
                <Shield className="h-4 w-4" />
                {t("watchtower")}
              </Link>
            </Button>
            <Button
              variant={isShareLinks ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/share-links" onClick={() => onOpenChange(false)}>
                <LinkIcon className="h-4 w-4" />
                {t("shareLinks")}
              </Link>
            </Button>
            <Button
              variant={isEmergencyAccess ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/emergency-access" onClick={() => onOpenChange(false)}>
                <HeartPulse className="h-4 w-4" />
                {t("emergencyAccess")}
              </Link>
            </Button>
            <SectionLabel icon={<ScrollText className="h-3 w-3" />}>
              {t("auditLog")}
            </SectionLabel>
            <div className="ml-4 space-y-1">
              <Button
                variant={isPersonalAuditLog ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                asChild
              >
                <Link href="/dashboard/audit-logs" onClick={() => onOpenChange(false)}>
                  <FolderOpen className="h-4 w-4" />
                  {t("auditLogPersonal")}
                </Link>
              </Button>
              {orgs.filter((org) => org.role === ORG_ROLE.OWNER || org.role === ORG_ROLE.ADMIN).map((org) => (
                <Button
                  key={org.id}
                  variant={activeAuditOrgId === org.id ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2"
                  asChild
                >
                  <Link
                    href={`/dashboard/orgs/${org.id}/audit-logs`}
                    onClick={() => onOpenChange(false)}
                  >
                    <Building2 className="h-4 w-4" />
                    <span className="truncate">{org.name}</span>
                  </Link>
                </Button>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      {/* ── Utilities ──────────────────────────────────────── */}
      <Collapsible open={isOpen("utilities")} onOpenChange={toggleSection("utilities")}>
        <CollapsibleSectionHeader isOpen={isOpen("utilities")}>
          {t("utilities")}
        </CollapsibleSectionHeader>
        <CollapsibleContent>
          <div className="space-y-1">
            {selectedOrg && (selectedOrg.role === ORG_ROLE.OWNER || selectedOrg.role === ORG_ROLE.ADMIN) && (
              <Button variant="ghost" className="w-full justify-start gap-2" asChild>
                <Link href={`/dashboard/orgs/${selectedOrg.id}/settings`} onClick={() => onOpenChange(false)}>
                  <Settings className="h-4 w-4" />
                  {tOrg("orgSettings")}
                </Link>
              </Button>
            )}
            <ExportDialog
              trigger={
                <Button variant="ghost" className="w-full justify-start gap-2">
                  <Download className="h-4 w-4" />
                  {t("export")}
                </Button>
              }
            />
            <ImportDialog
              trigger={
                <Button variant="ghost" className="w-full justify-start gap-2">
                  <Upload className="h-4 w-4" />
                  {t("import")}
                </Button>
              }
              onComplete={handleImportComplete}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
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

interface VaultSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  vaultContext: VaultContext;
  selectedOrgName?: string;
  isSelectedVaultAll: boolean;
  isSelectedVaultFavorites: boolean;
  isSelectedVaultArchive: boolean;
  isSelectedVaultTrash: boolean;
  onNavigate: () => void;
}

function VaultSection({
  isOpen,
  onOpenChange,
  t,
  vaultContext,
  selectedOrgName,
  isSelectedVaultAll,
  isSelectedVaultFavorites,
  isSelectedVaultArchive,
  isSelectedVaultTrash,
  onNavigate,
}: VaultSectionProps) {
  const isOrg = vaultContext.type === "org";

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>
        {isOrg ? (selectedOrgName ?? t("personalVault")) : t("personalVault")}
      </CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          <Button
            variant={isSelectedVaultAll ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}` : "/dashboard"} onClick={onNavigate}>
              <FolderOpen className="h-4 w-4" />
              {t("allPasswords")}
            </Link>
          </Button>
          <Button
            variant={isSelectedVaultFavorites ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link
              href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}?scope=favorites` : "/dashboard/favorites"}
              onClick={onNavigate}
            >
              <Star className="h-4 w-4" />
              {t("favorites")}
            </Link>
          </Button>
          <Button
            variant={isSelectedVaultArchive ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link
              href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}?scope=archive` : "/dashboard/archive"}
              onClick={onNavigate}
            >
              <Archive className="h-4 w-4" />
              {t("personalArchive")}
            </Link>
          </Button>
          <Button
            variant={isSelectedVaultTrash ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link
              href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}?scope=trash` : "/dashboard/trash"}
              onClick={onNavigate}
            >
              <Trash2 className="h-4 w-4" />
              {t("personalTrash")}
            </Link>
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface CategoriesSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  vaultContext: VaultContext;
  selectedTypeFilter: string | null;
  onNavigate: () => void;
}

function CategoriesSection({
  isOpen,
  onOpenChange,
  t,
  vaultContext,
  selectedTypeFilter,
  onNavigate,
}: CategoriesSectionProps) {
  const categories = [
    { type: ENTRY_TYPE.LOGIN, labelKey: "catLogin", icon: KeyRound },
    { type: ENTRY_TYPE.SECURE_NOTE, labelKey: "catSecureNote", icon: FileText },
    { type: ENTRY_TYPE.CREDIT_CARD, labelKey: "catCreditCard", icon: CreditCard },
    { type: ENTRY_TYPE.IDENTITY, labelKey: "catIdentity", icon: IdCard },
    { type: ENTRY_TYPE.PASSKEY, labelKey: "catPasskey", icon: Fingerprint },
  ] as const;

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>
        {t("categories")}
      </CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          {categories.map((category) => {
            const Icon = category.icon;
            const href =
              vaultContext.type === "org"
                ? `/dashboard/orgs/${vaultContext.orgId}?type=${category.type}`
                : `/dashboard?type=${category.type}`;
            return (
              <Button
                key={category.type}
                variant={selectedTypeFilter === category.type ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                asChild
              >
                <Link href={href} onClick={onNavigate}>
                  <Icon className="h-4 w-4" />
                  {t(category.labelKey)}
                </Link>
              </Button>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

/** Interactive collapsible section header with chevron indicator. */
function CollapsibleSectionHeader({
  children,
  icon,
  isOpen,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  isOpen: boolean;
}) {
  return (
    <CollapsibleTrigger asChild>
      <button type="button" className="w-full px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center justify-between gap-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm">
        <span className="flex items-center gap-1">
          {icon}
          {children}
        </span>
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
    </CollapsibleTrigger>
  );
}

/** Non-interactive label for sub-sections (e.g. Audit Log within Security). */
function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
      {icon}
      {children}
    </p>
  );
}
