"use client";

import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { ENTRY_TYPE } from "@/lib/constants";
import { type VaultContext } from "@/hooks/use-vault-context";
import { Building2, FolderOpen, Tag, Star, Archive, Trash2, KeyRound, FileText, CreditCard, IdCard, Fingerprint, Plus, Settings } from "lucide-react";
import { CollapsibleSectionHeader, FolderTreeNode, type SidebarFolderItem } from "@/components/layout/sidebar-shared";

interface SidebarOrgItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface OrganizeTagItem {
  id: string;
  name: string;
  color: string | null;
  count: number;
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

export function VaultSection({
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
          <Button variant={isSelectedVaultAll ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
            <Link href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}` : "/dashboard"} onClick={onNavigate}>
              <FolderOpen className="h-4 w-4" />
              {t("allPasswords")}
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
          <Button variant={isSelectedVaultArchive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
            <Link
              href={isOrg ? `/dashboard/orgs/${vaultContext.orgId}?scope=archive` : "/dashboard/archive"}
              onClick={onNavigate}
            >
              <Archive className="h-4 w-4" />
              {t("personalArchive")}
            </Link>
          </Button>
          <Button variant={isSelectedVaultTrash ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
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

interface OrganizationsSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  tOrg: (key: string) => string;
  orgs: SidebarOrgItem[];
  selectedOrgId: string | null;
  isOrgsManage: boolean;
  onNavigate: () => void;
}

export function OrganizationsSection({
  isOpen,
  onOpenChange,
  tOrg,
  orgs,
  selectedOrgId,
  isOrgsManage,
  onNavigate,
}: OrganizationsSectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader icon={<Building2 className="h-3 w-3" />} isOpen={isOpen}>
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
              <Link href={`/dashboard/orgs/${org.id}`} onClick={onNavigate}>
                <Building2 className="h-4 w-4" />
                <span className="truncate">{org.name}</span>
              </Link>
            </Button>
          ))}
          <Button variant={isOrgsManage ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
            <Link href="/dashboard/orgs" onClick={onNavigate}>
              <Settings className="h-4 w-4" />
              {tOrg("manage")}
            </Link>
          </Button>
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
  tags: OrganizeTagItem[];
  activeTagId: string | null;
  tagHref: (tagId: string) => string;
  onCreateFolder: () => void;
  onEditFolder: (folder: SidebarFolderItem) => void;
  onDeleteFolder: (folder: SidebarFolderItem) => void;
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
              <Button
                key={tag.id}
                variant={activeTagId === tag.id ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                asChild
              >
                <Link href={tagHref(tag.id)} onClick={onNavigate}>
                  <Badge
                    variant="outline"
                    className={cn("h-3 w-3 rounded-full p-0", colorClass && "tag-color-bg", colorClass)}
                  />
                  {tag.name}
                  <span className="ml-auto text-xs text-muted-foreground">{tag.count}</span>
                </Link>
              </Button>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
