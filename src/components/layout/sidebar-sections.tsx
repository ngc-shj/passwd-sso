"use client";

import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { ENTRY_TYPE } from "@/lib/constants";
import type { SidebarTeamTagItem } from "@/hooks/sidebar/use-sidebar-data";
import { type VaultContext } from "@/hooks/use-vault-context";
import {
  Tag,
  Star,
  Archive,
  Trash2,
  KeyRound,
  FileText,
  CreditCard,
  IdCard,
  Fingerprint,
  Landmark,
  KeySquare,
  Terminal,
  FolderOpen,
  Plus,
  Link as LinkIcon,
} from "lucide-react";
import { CollapsibleSectionHeader, FolderTreeNode, TagTreeNode, type SidebarFolderItem } from "@/components/layout/sidebar-shared";

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
  const isTeam = vaultContext.type === "team";
  const scopedTeamId = isTeam ? (vaultContext.teamId) : "";

  return (
    <div className="space-y-1">
      <Button variant={isSelectedVaultAll ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
        <Link href={isTeam ? `/dashboard/teams/${scopedTeamId}` : "/dashboard"} onClick={onNavigate}>
          <KeyRound className="h-4 w-4" />
          {t("passwords")}
        </Link>
      </Button>
      <Button variant={isSelectedVaultFavorites ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
        <Link
          href={isTeam ? `/dashboard/teams/${scopedTeamId}?scope=favorites` : "/dashboard/favorites"}
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
  const scopedTeamId =
    vaultContext.type === "team" ? (vaultContext.teamId) : "";
  const categories = [
    { type: ENTRY_TYPE.LOGIN, labelKey: "catLogin", icon: KeyRound },
    { type: ENTRY_TYPE.SECURE_NOTE, labelKey: "catSecureNote", icon: FileText },
    { type: ENTRY_TYPE.CREDIT_CARD, labelKey: "catCreditCard", icon: CreditCard },
    { type: ENTRY_TYPE.IDENTITY, labelKey: "catIdentity", icon: IdCard },
    { type: ENTRY_TYPE.PASSKEY, labelKey: "catPasskey", icon: Fingerprint },
    { type: ENTRY_TYPE.BANK_ACCOUNT, labelKey: "catBankAccount", icon: Landmark },
    { type: ENTRY_TYPE.SOFTWARE_LICENSE, labelKey: "catSoftwareLicense", icon: KeySquare },
    { type: ENTRY_TYPE.SSH_KEY, labelKey: "catSshKey", icon: Terminal },
  ] as const;

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("categories")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="ml-3 border-l pl-3 space-y-0.5">
          {categories.map((category) => {
            const Icon = category.icon;
            const href =
              vaultContext.type === "team"
                ? `/dashboard/teams/${scopedTeamId}?type=${category.type}`
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

interface FoldersSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  canCreate: boolean;
  folders: SidebarFolderItem[];
  activeFolderId: string | null;
  linkHref: (folderId: string) => string;
  showMenu: boolean;
  onNavigate: () => void;
  onCreate: () => void;
  onEdit: (folder: SidebarFolderItem) => void;
  onDelete: (folder: SidebarFolderItem) => void;
}

export function FoldersSection({
  isOpen,
  onOpenChange,
  t,
  canCreate,
  folders,
  activeFolderId,
  linkHref,
  showMenu,
  onNavigate,
  onCreate,
  onEdit,
  onDelete,
}: FoldersSectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <div className="flex items-center">
        <div className="flex-1">
          <CollapsibleSectionHeader icon={<FolderOpen className="h-3 w-3" />} isOpen={isOpen}>{t("folders")}</CollapsibleSectionHeader>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 mr-1"
          disabled={!canCreate}
          onClick={onCreate}
          aria-label={t("createFolder")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <CollapsibleContent>
        <div className="ml-3 border-l pl-3 space-y-0.5">
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
                showMenu={showMenu}
                onNavigate={onNavigate}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface TagsSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  tags: SidebarTeamTagItem[];
  activeTagId: string | null;
  tagHref: (tagId: string) => string;
  showMenu: boolean;
  onNavigate: () => void;
  onEdit: (tag: SidebarTeamTagItem) => void;
  onDelete: (tag: SidebarTeamTagItem) => void;
}

export function TagsSection({
  isOpen,
  onOpenChange,
  t,
  tags,
  activeTagId,
  tagHref,
  showMenu,
  onNavigate,
  onEdit,
  onDelete,
}: TagsSectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader icon={<Tag className="h-3 w-3" />} isOpen={isOpen}>
        {t("tags")}
      </CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="ml-3 border-l pl-3 space-y-0.5">
          {tags
            .filter((tag) => !tag.parentId)
            .map((tag) => (
              <TagTreeNode
                key={tag.id}
                tag={tag}
                tags={tags}
                activeTagId={activeTagId}
                depth={0}
                linkHref={tagHref}
                showMenu={showMenu}
                onNavigate={onNavigate}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
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
  onNavigate: () => void;
}

export function VaultManagementSection({
  t,
  vaultContext,
  isSelectedVaultArchive,
  isSelectedVaultTrash,
  isShareLinks,
  onNavigate,
}: VaultManagementSectionProps) {
  const isTeam = vaultContext.type === "team";
  const scopedTeamId = isTeam ? (vaultContext.teamId) : "";
  const shareLinksHref = isTeam
    ? `/dashboard/share-links?team=${encodeURIComponent(scopedTeamId)}`
    : "/dashboard/share-links";

  return (
    <div className="space-y-1">
      <Button
        variant={isSelectedVaultArchive ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        asChild
      >
        <Link
          href={isTeam ? `/dashboard/teams/${scopedTeamId}?scope=archive` : "/dashboard/archive"}
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
          href={isTeam ? `/dashboard/teams/${scopedTeamId}?scope=trash` : "/dashboard/trash"}
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
    </div>
  );
}
