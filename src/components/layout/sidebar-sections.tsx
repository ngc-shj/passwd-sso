"use client";

import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { ENTRY_TYPE } from "@/lib/constants";
import type { SidebarOrganizeTagItem } from "@/hooks/use-sidebar-data";
import { type VaultContext } from "@/hooks/use-vault-context";
import {
  FolderOpen,
  Tag,
  Star,
  Archive,
  Trash2,
  KeyRound,
  FileText,
  CreditCard,
  IdCard,
  Fingerprint,
  Plus,
  Link as LinkIcon,
  ScrollText,
  MoreHorizontal,
  Pencil,
  Trash2 as TrashIcon,
} from "lucide-react";
import { CollapsibleSectionHeader, FolderTreeNode, type SidebarFolderItem } from "@/components/layout/sidebar-shared";

interface VaultSectionProps {
  t: (key: string) => string;
  vaultContext: VaultContext;
  isSelectedVaultAll: boolean;
  isSelectedVaultFavorites: boolean;
  onNavigate: () => void;
}

export function VaultSection({
  t,
  vaultContext,
  isSelectedVaultAll,
  isSelectedVaultFavorites,
  onNavigate,
}: VaultSectionProps) {
  const isOrg = vaultContext.type === "org";

  return (
    <div className="space-y-1">
      <Button variant={isSelectedVaultAll ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
        <Link href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}` : "/dashboard"} onClick={onNavigate}>
          <FolderOpen className="h-4 w-4" />
          {t("passwords")}
        </Link>
      </Button>
      <Button variant={isSelectedVaultFavorites ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
        <Link
          href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}?scope=favorites` : "/dashboard/favorites"}
          onClick={onNavigate}
        >
          <Star className="h-4 w-4" />
          {t("favorites")}
        </Link>
      </Button>
    </div>
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

export function CategoriesSection({
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
      <CollapsibleSectionHeader isOpen={isOpen}>{t("categories")}</CollapsibleSectionHeader>
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

interface OrganizeSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  canCreateFolder: boolean;
  folders: SidebarFolderItem[];
  activeFolderId: string | null;
  linkHref: (folderId: string) => string;
  showFolderMenu: boolean;
  tags: SidebarOrganizeTagItem[];
  activeTagId: string | null;
  tagHref: (tagId: string) => string;
  onCreateFolder: () => void;
  onEditFolder: (folder: SidebarFolderItem) => void;
  onDeleteFolder: (folder: SidebarFolderItem) => void;
  onEditTag: (tag: SidebarOrganizeTagItem) => void;
  onDeleteTag: (tag: SidebarOrganizeTagItem) => void;
  showTagMenu: boolean;
  onNavigate: () => void;
}

export function OrganizeSection({
  isOpen,
  onOpenChange,
  t,
  canCreateFolder,
  folders,
  activeFolderId,
  linkHref,
  showFolderMenu,
  tags,
  activeTagId,
  tagHref,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
  onEditTag,
  onDeleteTag,
  showTagMenu,
  onNavigate,
}: OrganizeSectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <div className="flex items-center">
        <div className="flex-1">
          <CollapsibleSectionHeader icon={<Tag className="h-3 w-3" />} isOpen={isOpen}>
            {t("organize")}
          </CollapsibleSectionHeader>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 mr-1"
          onClick={onCreateFolder}
          disabled={!canCreateFolder}
          aria-label={t("createFolder")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <CollapsibleContent>
        <div className="space-y-1 mb-2">
          {folders
            .filter((folder) => !folder.parentId)
            .map((folder) => (
              <FolderTreeNode
                key={folder.id}
                folder={folder}
                folders={folders}
                activeFolderId={activeFolderId}
                depth={0}
                linkHref={linkHref}
                showMenu={showFolderMenu}
                onNavigate={onNavigate}
                onEdit={onEditFolder}
                onDelete={onDeleteFolder}
              />
            ))}
        </div>
        <div className="space-y-1">
          {tags.map((tag) => {
            const colorClass = getTagColorClass(tag.color);
            return (
              <div key={tag.id} className="group/tag flex items-center">
                <Button
                  variant={activeTagId === tag.id ? "secondary" : "ghost"}
                  className="flex-1 justify-start gap-2"
                  asChild
                >
                  <Link href={tagHref(tag.id)} onClick={onNavigate}>
                    <Badge
                      variant="outline"
                      className={cn("h-3 w-3 rounded-full p-0", colorClass && "tag-color-bg", colorClass)}
                    />
                    <span className="truncate">{tag.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{tag.count}</span>
                  </Link>
                </Button>
                {showTagMenu && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 opacity-0 group-hover/tag:opacity-100 focus:opacity-100"
                        aria-label={`${tag.name} menu`}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEditTag(tag)}>
                        <Pencil className="h-3.5 w-3.5 mr-2" />
                        {t("editTag")}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => onDeleteTag(tag)}>
                        <TrashIcon className="h-3.5 w-3.5 mr-2" />
                        {t("deleteTag")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface VaultManagementSectionProps {
  t: (key: string) => string;
  vaultContext: VaultContext;
  isSelectedVaultArchive: boolean;
  isSelectedVaultTrash: boolean;
  isShareLinks: boolean;
  isPersonalAuditLog: boolean;
  activeAuditOrgId: string | null;
  onNavigate: () => void;
}

export function VaultManagementSection({
  t,
  vaultContext,
  isSelectedVaultArchive,
  isSelectedVaultTrash,
  isShareLinks,
  isPersonalAuditLog,
  activeAuditOrgId,
  onNavigate,
}: VaultManagementSectionProps) {
  const isOrg = vaultContext.type === "org";
  const shareLinksHref = isOrg
    ? `/dashboard/share-links?org=${encodeURIComponent(vaultContext.orgId)}`
    : "/dashboard/share-links";
  const auditLogHref = isOrg
    ? `/dashboard/orgs/${vaultContext.orgId}/audit-logs`
    : "/dashboard/audit-logs";
  const isAuditActive = isOrg
    ? activeAuditOrgId === vaultContext.orgId
    : isPersonalAuditLog;

  return (
    <div className="space-y-1">
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
          {t("archive")}
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
          {t("trash")}
        </Link>
      </Button>
      <Button
        variant={isShareLinks ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        asChild
      >
        <Link href={shareLinksHref} onClick={onNavigate}>
          <LinkIcon className="h-4 w-4" />
          {t("shareLinks")}
        </Link>
      </Button>
      <Button
        variant={isAuditActive ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        asChild
      >
        <Link href={auditLogHref} onClick={onNavigate}>
          <ScrollText className="h-4 w-4" />
          {t("auditLog")}
        </Link>
      </Button>
    </div>
  );
}
