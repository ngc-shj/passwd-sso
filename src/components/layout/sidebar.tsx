"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
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

  // ─── Collapsible state ──────────────────────────────────────────

  const [collapsed, setCollapsed] = useLocalStorage<Record<SidebarSection, boolean>>(
    "sidebar-collapsed",
    COLLAPSE_DEFAULTS
  );
  const [orgMenuOpen, setOrgMenuOpen] = useState<Record<string, boolean>>({});

  const isOpen = (k: SidebarSection) => !collapsed[k];

  const toggleSection = (k: SidebarSection) => (open: boolean) =>
    setCollapsed((prev) => ({ ...prev, [k]: !open }));
  const isOrgMenuOpen = (orgId: string) =>
    orgMenuOpen[orgId] ?? (activeOrgId === orgId);
  const setOrgMenuSection = (orgId: string, open: boolean) =>
    setOrgMenuOpen((prev) => ({ ...prev, [orgId]: open }));

  // Auto-expand section when navigating to a route within it.
  // One-time per navigation — user can manually close afterward.
  useEffect(() => {
    const toOpen: SidebarSection[] = [];
    if (isVaultAll || isVaultFavorites || isVaultArchive || isVaultTrash) toOpen.push("vault");
    if (activeTypeFilter !== null) toOpen.push("categories");
    if (activeOrgId !== null || isOrgsManage) toOpen.push("organizations");
    if (activeTagId !== null || activeOrgTagId !== null || activeFolderId !== null || activeOrgFolderId !== null) toOpen.push("organize");
    if (isWatchtower || isShareLinks || isEmergencyAccess || isAuditLog) toOpen.push("security");

    if (toOpen.length > 0) {
      setCollapsed((prev) => {
        const next = { ...prev };
        for (const k of toOpen) next[k] = false;
        return next;
      });
    }
  }, [pathname, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {/* ── Vault ──────────────────────────────────────────── */}
      <Collapsible open={isOpen("vault")} onOpenChange={toggleSection("vault")}>
        <CollapsibleSectionHeader isOpen={isOpen("vault")}>
          {t("personalVault")}
        </CollapsibleSectionHeader>
        <CollapsibleContent>
          <div className="space-y-1">
            <Button
              variant={isVaultAll ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard" onClick={() => onOpenChange(false)}>
                <FolderOpen className="h-4 w-4" />
                {t("allPasswords")}
              </Link>
            </Button>
            <Button
              variant={isVaultFavorites ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/favorites" onClick={() => onOpenChange(false)}>
                <Star className="h-4 w-4" />
                {t("favorites")}
              </Link>
            </Button>
            <Button
              variant={isVaultArchive ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/archive" onClick={() => onOpenChange(false)}>
                <Archive className="h-4 w-4" />
                {t("personalArchive")}
              </Link>
            </Button>
            <Button
              variant={isVaultTrash ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/trash" onClick={() => onOpenChange(false)}>
                <Trash2 className="h-4 w-4" />
                {t("personalTrash")}
              </Link>
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* ── Categories ─────────────────────────────────────── */}
      <Collapsible open={isOpen("categories")} onOpenChange={toggleSection("categories")}>
        <CollapsibleSectionHeader isOpen={isOpen("categories")}>
          {t("categories")}
        </CollapsibleSectionHeader>
        <CollapsibleContent>
          <div className="space-y-1">
            <Button
              variant={activeTypeFilter === ENTRY_TYPE.LOGIN ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
            <Link href={`/dashboard?type=${ENTRY_TYPE.LOGIN}`} onClick={() => onOpenChange(false)}>
                <KeyRound className="h-4 w-4" />
                {t("catLogin")}
              </Link>
            </Button>
            <Button
              variant={activeTypeFilter === ENTRY_TYPE.SECURE_NOTE ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard?type=SECURE_NOTE" onClick={() => onOpenChange(false)}>
                <FileText className="h-4 w-4" />
                {t("catSecureNote")}
              </Link>
            </Button>
            <Button
              variant={activeTypeFilter === ENTRY_TYPE.CREDIT_CARD ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard?type=CREDIT_CARD" onClick={() => onOpenChange(false)}>
                <CreditCard className="h-4 w-4" />
                {t("catCreditCard")}
              </Link>
            </Button>
            <Button
              variant={activeTypeFilter === ENTRY_TYPE.IDENTITY ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard?type=IDENTITY" onClick={() => onOpenChange(false)}>
                <IdCard className="h-4 w-4" />
                {t("catIdentity")}
              </Link>
            </Button>
            <Button
              variant={activeTypeFilter === ENTRY_TYPE.PASSKEY ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard?type=PASSKEY" onClick={() => onOpenChange(false)}>
                <Fingerprint className="h-4 w-4" />
                {t("catPasskey")}
              </Link>
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

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
              <div key={org.id}>
                <div className="flex items-center gap-1">
                  <Button
                    variant={
                      activeOrgId === org.id &&
                      !activeOrgTypeFilter &&
                      !activeOrgScope
                        ? "secondary"
                        : "ghost"
                    }
                    className="flex-1 justify-start gap-2"
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() =>
                      setOrgMenuSection(org.id, !isOrgMenuOpen(org.id))
                    }
                    aria-label={`toggle-${org.id}`}
                  >
                    {isOrgMenuOpen(org.id) ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </Button>
                </div>
                {isOrgMenuOpen(org.id) && (() => {
                  const orgFolderGroup = orgFolderGroups.find((g) => g.orgId === org.id);
                  const orgFolders = orgFolderGroup?.folders ?? [];
                  const canManageFolders = org.role === ORG_ROLE.OWNER || org.role === ORG_ROLE.ADMIN;
                  return (
                  <div className="ml-6 space-y-0.5">
                    <Button
                      variant={activeOrgTypeFilter === ENTRY_TYPE.LOGIN ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                    <Link href={`/dashboard/orgs/${org.id}?type=${ENTRY_TYPE.LOGIN}`} onClick={() => onOpenChange(false)}>
                        <KeyRound className="h-3.5 w-3.5" />
                        {t("catLogin")}
                      </Link>
                    </Button>
                    <Button
                      variant={activeOrgTypeFilter === ENTRY_TYPE.SECURE_NOTE ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={`/dashboard/orgs/${org.id}?type=SECURE_NOTE`} onClick={() => onOpenChange(false)}>
                        <FileText className="h-3.5 w-3.5" />
                        {t("catSecureNote")}
                      </Link>
                    </Button>
                    <Button
                      variant={activeOrgTypeFilter === ENTRY_TYPE.CREDIT_CARD ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={`/dashboard/orgs/${org.id}?type=CREDIT_CARD`} onClick={() => onOpenChange(false)}>
                        <CreditCard className="h-3.5 w-3.5" />
                        {t("catCreditCard")}
                      </Link>
                    </Button>
                    <Button
                      variant={activeOrgTypeFilter === ENTRY_TYPE.IDENTITY ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={`/dashboard/orgs/${org.id}?type=IDENTITY`} onClick={() => onOpenChange(false)}>
                        <IdCard className="h-3.5 w-3.5" />
                        {t("catIdentity")}
                      </Link>
                    </Button>
                    <Button
                      variant={activeOrgTypeFilter === ENTRY_TYPE.PASSKEY ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={`/dashboard/orgs/${org.id}?type=PASSKEY`} onClick={() => onOpenChange(false)}>
                        <Fingerprint className="h-3.5 w-3.5" />
                        {t("catPasskey")}
                      </Link>
                    </Button>
                    {(orgFolders.length > 0 || canManageFolders) && (
                      <>
                        <Separator className="my-1" />
                        <div className="flex items-center">
                          <SectionLabel icon={<FolderOpen className="h-3 w-3" />}>
                            {t("folders")}
                          </SectionLabel>
                          {canManageFolders && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 shrink-0 ml-auto"
                              onClick={() => handleFolderCreate(org.id)}
                              aria-label={`${org.name} createFolder`}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                        <div className="space-y-0.5">
                          {orgFolders
                            .filter((f) => !f.parentId)
                            .map((folder) => (
                              <FolderTreeNode
                                key={folder.id}
                                folder={folder}
                                folders={orgFolders}
                                activeFolderId={activeOrgFolderId}
                                depth={0}
                                linkHref={(id) => `/dashboard/orgs/${org.id}?folder=${id}`}
                                showMenu={canManageFolders}
                                onNavigate={() => onOpenChange(false)}
                                onEdit={(f) => handleFolderEdit(f, org.id)}
                                onDelete={(f) => handleFolderDeleteClick(f, org.id)}
                              />
                            ))}
                        </div>
                      </>
                    )}
                    <Separator className="my-1" />
                    <Button
                      variant={activeOrgScope === "archive" ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={`/dashboard/orgs/${org.id}?scope=archive`} onClick={() => onOpenChange(false)}>
                        <Archive className="h-3.5 w-3.5" />
                        {t("archive")}
                      </Link>
                    </Button>
                    <Button
                      variant={activeOrgScope === "trash" ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={`/dashboard/orgs/${org.id}?scope=trash`} onClick={() => onOpenChange(false)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("trash")}
                      </Link>
                    </Button>
                  </div>
                  );
                })()}
              </div>
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
            onClick={() => handleFolderCreate()}
            aria-label={t("createFolder")}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <CollapsibleContent>
          <div className="space-y-1 mb-2">
            {folders
              .filter((f) => !f.parentId)
              .map((folder) => (
                <FolderTreeNode
                  key={folder.id}
                  folder={folder}
                  folders={folders}
                  activeFolderId={activeFolderId}
                  depth={0}
                  linkHref={(id) => `/dashboard/folders/${id}`}
                  onNavigate={() => onOpenChange(false)}
                  onEdit={(f) => handleFolderEdit(f)}
                  onDelete={(f) => handleFolderDeleteClick(f)}
                />
              ))}
          </div>
          <div className="space-y-1">
            {tags.filter((tg) => tg.passwordCount > 0).map((tag) => {
              const colorClass = getTagColorClass(tag.color);
              return (
                <Button
                  key={tag.id}
                  variant={activeTagId === tag.id ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2"
                  asChild
                >
                  <Link
                    href={`/dashboard/tags/${tag.id}`}
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
                      {tag.passwordCount}
                    </span>
                  </Link>
                </Button>
              );
            })}
          </div>

          {orgTagGroups.map((group) => (
            <div key={group.orgId}>
              <SectionLabel icon={<Building2 className="h-3 w-3" />}>
                {group.orgName}
              </SectionLabel>
              <div className="space-y-1">
                {group.tags.map((tag) => {
                  const colorClass = getTagColorClass(tag.color);
                  return (
                    <Button
                      key={tag.id}
                      variant={activeOrgTagId === tag.id ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2"
                      asChild
                    >
                      <Link
                        href={`/dashboard/orgs/${group.orgId}?tag=${tag.id}`}
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
            </div>
          ))}
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
