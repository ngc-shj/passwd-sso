"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, ChevronRight, FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

export interface SidebarFolderItem {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  entryCount: number;
}

function isAncestorOf(folderId: string, targetId: string, folders: SidebarFolderItem[]): boolean {
  const map = new Map(folders.map((f) => [f.id, f]));
  let current = map.get(targetId);
  while (current) {
    if (current.parentId === folderId) return true;
    current = current.parentId ? map.get(current.parentId) : undefined;
  }
  return false;
}

interface FolderTreeNodeProps {
  folder: SidebarFolderItem;
  folders: SidebarFolderItem[];
  activeFolderId: string | null;
  depth: number;
  linkHref: (folderId: string) => string;
  showMenu?: boolean;
  onNavigate: () => void;
  onEdit: (folder: SidebarFolderItem) => void;
  onDelete: (folder: SidebarFolderItem) => void;
}

export function FolderTreeNode({
  folder,
  folders,
  activeFolderId,
  depth,
  linkHref,
  showMenu,
  onNavigate,
  onEdit,
  onDelete,
}: FolderTreeNodeProps) {
  const tCommon = useTranslations("Common");
  const tDashboard = useTranslations("Dashboard");
  const children = folders.filter((f) => f.parentId === folder.id);
  const hasChildren = children.length > 0;

  const isAncestorOfActive = activeFolderId
    ? isAncestorOf(folder.id, activeFolderId, folders)
    : false;
  const [open, setOpen] = useState(isAncestorOfActive);
  const isExpanded = open || isAncestorOfActive;

  return (
    <>
      <div className="group/folder flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
        <Button
          variant={activeFolderId === folder.id ? "secondary" : "ghost"}
          className="flex-1 justify-start gap-2 min-w-0"
          asChild
        >
          <Link href={linkHref(folder.id)} onClick={onNavigate}>
            {hasChildren ? (
              <span
                className="relative shrink-0 h-4 w-4"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen((prev) => !prev);
                }}
                role="button"
                aria-label={isExpanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
              >
                <FolderOpen className="h-4 w-4 transition-opacity group-hover/folder:opacity-0" />
                <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/folder:opacity-100">
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
              </span>
            ) : (
              <FolderOpen className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{folder.name}</span>
          </Link>
        </Button>
        {showMenu !== false ? (
          <div className="group/fmenu shrink-0 relative flex items-center justify-center w-7 h-7">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="peer absolute inset-0 h-7 w-7 opacity-0 transition-opacity group-hover/fmenu:opacity-100 focus:opacity-100"
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
                <DropdownMenuItem className="text-destructive" onClick={() => onDelete(folder)}>
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  {tDashboard("deleteFolder")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {folder.entryCount > 0 && (
              <span className="text-xs text-muted-foreground transition-opacity group-hover/fmenu:opacity-0 peer-focus:opacity-0 pointer-events-none">
                {folder.entryCount}
              </span>
            )}
          </div>
        ) : folder.entryCount > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground px-2">
            {folder.entryCount}
          </span>
        ) : null}
      </div>
      {hasChildren &&
        isExpanded &&
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

export function CollapsibleSectionHeader({
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
      <button
        type="button"
        className="w-full px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center justify-between gap-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
        aria-expanded={isOpen}
      >
        <span className="flex items-center gap-1">
          {icon}
          {children}
        </span>
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
    </CollapsibleTrigger>
  );
}

export function SectionLabel({
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
