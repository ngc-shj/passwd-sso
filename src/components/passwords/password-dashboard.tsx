"use client";

import { useState, useRef, useEffect, Fragment, useCallback } from "react";
import { useTranslations } from "next-intl";
import { SearchBar } from "@/components/layout/search-bar";
import { PasswordList, type SortOption, type PasswordListHandle } from "@/components/passwords/password-list";
import { TrashList, type TrashListHandle } from "@/components/passwords/trash-list";
import { PasswordNewDialog } from "@/components/passwords/password-new-dialog";
import { EntryListHeader } from "@/components/passwords/entry-list-header";
import { EntrySortMenu } from "@/components/passwords/entry-sort-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, KeyRound, FileText, CreditCard, IdCard, Fingerprint, Star, Archive, Trash2, CheckSquare, Landmark, KeySquare, FolderOpen, Tag } from "lucide-react";
import type { EntryTypeValue } from "@/lib/constants";
import { ENTRY_TYPE } from "@/lib/constants";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import { usePersonalTags } from "@/hooks/use-personal-tags";
import { buildFolderPath } from "@/lib/folder-path";
import type { TagData } from "@/components/tags/tag-input";

type VaultView = "all" | "favorites" | "archive" | "trash";

interface PasswordDashboardProps {
  view: VaultView;
  tagId?: string | null;
  folderId?: string | null;
  entryType?: string | null;
}

export function PasswordDashboard({ view, tagId, folderId, entryType }: PasswordDashboardProps) {
  const t = useTranslations("Dashboard");
  const tl = useTranslations("PasswordList");
  const ts = useTranslations("Shortcuts");

  const [searchQuery, setSearchQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [sortBy, setSortBy] = useState<SortOption>("updatedAt");
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newEntryType, setNewEntryType] = useState<EntryTypeValue>(ENTRY_TYPE.LOGIN);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [allSelected, setAllSelected] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const passwordListRef = useRef<PasswordListHandle>(null);
  const trashListRef = useRef<TrashListHandle>(null);

  const { folders } = usePersonalFolders();
  const { tags } = usePersonalTags();

  const isTrash = view === "trash";
  const isFavorites = view === "favorites";
  const isArchive = view === "archive";
  const contextualEntryType = entryType && Object.values(ENTRY_TYPE).includes(entryType as EntryTypeValue)
    ? (entryType as EntryTypeValue)
    : null;

  const ENTRY_TYPE_TITLES: Record<string, string> = {
    LOGIN: t("catLogin"),
    SECURE_NOTE: t("catSecureNote"),
    CREDIT_CARD: t("catCreditCard"),
    IDENTITY: t("catIdentity"),
    PASSKEY: t("catPasskey"),
    BANK_ACCOUNT: t("catBankAccount"),
    SOFTWARE_LICENSE: t("catSoftwareLicense"),
  };

  const folderLabel = folderId ? buildFolderPath(folderId, folders) : null;
  const matchedTag = tagId ? tags.find((tag) => tag.id === tagId) : undefined;
  const tagLabel = matchedTag?.name;

  const subtitle = isTrash
    ? t("trash")
    : isFavorites
      ? t("favorites")
      : isArchive
        ? t("archive")
        : entryType && ENTRY_TYPE_TITLES[entryType]
          ? ENTRY_TYPE_TITLES[entryType]
          : folderLabel ?? tagLabel ?? t("passwords");

  const ENTRY_TYPE_ICONS: Record<string, React.ReactNode> = {
    LOGIN: <KeyRound className="h-6 w-6" />,
    SECURE_NOTE: <FileText className="h-6 w-6" />,
    CREDIT_CARD: <CreditCard className="h-6 w-6" />,
    IDENTITY: <IdCard className="h-6 w-6" />,
    PASSKEY: <Fingerprint className="h-6 w-6" />,
    BANK_ACCOUNT: <Landmark className="h-6 w-6" />,
    SOFTWARE_LICENSE: <KeySquare className="h-6 w-6" />,
  };

  const headerIcon = isTrash
    ? <Trash2 className="h-6 w-6" />
    : isFavorites
      ? <Star className="h-6 w-6" />
      : isArchive
        ? <Archive className="h-6 w-6" />
        : entryType && ENTRY_TYPE_ICONS[entryType]
          ? ENTRY_TYPE_ICONS[entryType]
          : folderId
            ? <FolderOpen className="h-6 w-6" />
            : tagId
              ? <Tag className="h-6 w-6" />
              : <KeyRound className="h-6 w-6" />;

  const defaultTagData: TagData[] | undefined = matchedTag
    ? [{ id: matchedTag.id, name: matchedTag.name, color: matchedTag.color }]
    : undefined;

  const isPersonalAll = !isTrash && !isArchive && !isFavorites && !entryType && !tagId && !folderId;
  const isCategorySelected = !!(entryType && ENTRY_TYPE_TITLES[entryType]);
  const isFolderOrTagSelected = Boolean(tagId || folderId);
  const isPrimaryScopeLabel =
    isTrash || isArchive || isFavorites || isPersonalAll || isCategorySelected || isFolderOrTagSelected;

  // Reset selection mode when view changes (adjust state during render)
  const viewKey = `${view}|${tagId}|${folderId}|${entryType}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey);
    setSelectionMode(false);
  }

  const handleSelectedCountChange = useCallback((count: number, isAllSelected: boolean) => {
    setSelectedCount(count);
    setAllSelected(isAllSelected);
  }, []);

  const activeListRef = isTrash ? trashListRef : passwordListRef;

  // Listen for vault-data-changed (import, etc.)
  useEffect(() => {
    const handler = () => setRefreshKey((k) => k + 1);
    window.addEventListener("vault-data-changed", handler);
    return () => window.removeEventListener("vault-data-changed", handler);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA"
        || target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        if (inInput && searchQuery) {
          setSearchQuery("");
          searchRef.current?.blur();
          return;
        }
        if (selectionMode) {
          setSelectionMode(false);
          return;
        }
        if (searchQuery) {
          setSearchQuery("");
          searchRef.current?.blur();
        }
        return;
      }

      if (inInput) return;

      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        if (!isTrash && !isArchive) {
          if (contextualEntryType) setNewEntryType(contextualEntryType);
          setNewDialogOpen(true);
        }
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchQuery, isTrash, isArchive, contextualEntryType, selectionMode]);

  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const mod = isMac ? "⌘" : "Ctrl+";

  const shortcuts: [string, string][] = [
    [`/ ${ts("or")} ${mod}K`, ts("search")],
    ["N", ts("newPassword")],
    ["Esc", ts("escape")],
    ["?", ts("help")],
  ];

  const handleDataChange = () => {
    setRefreshKey((k) => k + 1);
    window.dispatchEvent(new CustomEvent("vault-data-changed"));
  };

  return (
    <div className="flex-1 p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <EntryListHeader
          icon={headerIcon}
          title={isPrimaryScopeLabel ? subtitle : t("personalVault")}
          subtitle={subtitle}
          showSubtitle={!isPrimaryScopeLabel}
          actions={
            selectionMode ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => activeListRef.current?.toggleSelectAll(Boolean(v))}
                    aria-label={t("selectAll")}
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {selectedCount > 0
                      ? tl("selectedCount", { count: selectedCount })
                      : t("selectAll")}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectionMode(false)}
                >
                  {t("close")}
                </Button>
              </div>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectionMode(true)}
                >
                  <CheckSquare className="h-4 w-4 mr-2" />
                  {t("select")}
                </Button>
                {!isTrash && !isArchive && (
                  contextualEntryType ? (
                    <Button
                      onClick={() => {
                        setNewEntryType(contextualEntryType);
                        setNewDialogOpen(true);
                      }}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      {t("newItem")}
                    </Button>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button>
                          <Plus className="h-4 w-4 mr-2" />
                          {t("newItem")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.LOGIN); setNewDialogOpen(true); }}>
                          <KeyRound className="h-4 w-4 mr-2" />
                          {t("newPassword")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.SECURE_NOTE); setNewDialogOpen(true); }}>
                          <FileText className="h-4 w-4 mr-2" />
                          {t("newSecureNote")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.CREDIT_CARD); setNewDialogOpen(true); }}>
                          <CreditCard className="h-4 w-4 mr-2" />
                          {t("newCreditCard")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.IDENTITY); setNewDialogOpen(true); }}>
                          <IdCard className="h-4 w-4 mr-2" />
                          {t("newIdentity")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.PASSKEY); setNewDialogOpen(true); }}>
                          <Fingerprint className="h-4 w-4 mr-2" />
                          {t("newPasskey")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.BANK_ACCOUNT); setNewDialogOpen(true); }}>
                          <Landmark className="h-4 w-4 mr-2" />
                          {t("newBankAccount")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.SOFTWARE_LICENSE); setNewDialogOpen(true); }}>
                          <KeySquare className="h-4 w-4 mr-2" />
                          {t("newSoftwareLicense")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                )}
              </>
            )
          }
        />

        <div className="mb-4 flex items-center gap-2 rounded-xl border bg-card/80 p-3">
          <div className="flex-1">
            <SearchBar ref={searchRef} value={searchQuery} onChange={setSearchQuery} />
          </div>
          {!isTrash && !isArchive && (
            <EntrySortMenu
              sortBy={sortBy}
              onSortByChange={setSortBy}
              labels={{
                updated: t("sortUpdated"),
                created: t("sortCreated"),
                title: t("sortTitle"),
              }}
            />
          )}
        </div>

        <div className="space-y-4">
          {isTrash ? (
            <TrashList
              refreshKey={refreshKey}
              selectionMode={selectionMode}
              onSelectedCountChange={handleSelectedCountChange}
              selectAllRef={trashListRef}
            />
          ) : (
            <PasswordList
              searchQuery={searchQuery}
              tagId={tagId ?? null}
              folderId={folderId ?? null}
              entryType={entryType}
              refreshKey={refreshKey}
              favoritesOnly={isFavorites}
              archivedOnly={isArchive}
              sortBy={sortBy}
              onDataChange={handleDataChange}
              selectionMode={selectionMode}
              onSelectedCountChange={handleSelectedCountChange}
              selectAllRef={passwordListRef}
            />
          )}
        </div>
      </div>

      <PasswordNewDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onSaved={handleDataChange}
        entryType={newEntryType}
        defaultFolderId={folderId ?? null}
        defaultTags={defaultTagData}
      />

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{ts("title")}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border bg-muted/20 p-4 text-sm">
            {shortcuts.map(([keys, label]) => (
              <Fragment key={keys}>
                <kbd className="inline-flex items-center justify-end gap-0.5 font-mono text-xs text-muted-foreground">
                  {keys}
                </kbd>
                <span>{label}</span>
              </Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
