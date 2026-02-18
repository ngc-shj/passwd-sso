"use client";

import { useState, useRef, useEffect, Fragment } from "react";
import { useTranslations } from "next-intl";
import { SearchBar } from "@/components/layout/search-bar";
import { PasswordList, type SortOption } from "@/components/passwords/password-list";
import { TrashList } from "@/components/passwords/trash-list";
import { OrgFavoritesList } from "@/components/org/org-favorites-list";
import { PasswordNewDialog } from "@/components/passwords/password-new-dialog";
import { EntryListHeader } from "@/components/passwords/entry-list-header";
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
import { Plus, ArrowUpDown, KeyRound, FileText, CreditCard, IdCard, Fingerprint } from "lucide-react";
import type { EntryTypeValue } from "@/lib/constants";
import { ENTRY_TYPE } from "@/lib/constants";

type VaultView = "all" | "favorites" | "archive" | "trash";

interface PasswordDashboardProps {
  view: VaultView;
  tagId?: string | null;
  folderId?: string | null;
  entryType?: string | null;
}

export function PasswordDashboard({ view, tagId, folderId, entryType }: PasswordDashboardProps) {
  const t = useTranslations("Dashboard");
  const ts = useTranslations("Shortcuts");

  const [searchQuery, setSearchQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [sortBy, setSortBy] = useState<SortOption>("updatedAt");
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newEntryType, setNewEntryType] = useState<EntryTypeValue>(ENTRY_TYPE.LOGIN);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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
  };

  const subtitle = isTrash
    ? t("trash")
    : isFavorites
      ? t("favorites")
      : isArchive
        ? t("archive")
        : entryType && ENTRY_TYPE_TITLES[entryType]
          ? ENTRY_TYPE_TITLES[entryType]
          : t("passwords");
  const isPersonalAll = !isTrash && !isArchive && !isFavorites && !entryType && !tagId && !folderId;
  const isCategorySelected = !!(entryType && ENTRY_TYPE_TITLES[entryType]);
  const isFolderOrTagSelected = Boolean(tagId || folderId);
  const isPrimaryScopeLabel =
    isTrash || isArchive || isFavorites || isPersonalAll || isCategorySelected || isFolderOrTagSelected;

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
  }, [searchQuery, isTrash, isArchive, contextualEntryType]);

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
          title={isPrimaryScopeLabel ? subtitle : t("personalVault")}
          subtitle={subtitle}
          showSubtitle={!isPrimaryScopeLabel}
          actions={
            <>
              {!isTrash && !isArchive && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <ArrowUpDown className="h-4 w-4 mr-1" />
                      {sortBy === "title" ? t("sortTitle") : sortBy === "createdAt" ? t("sortCreated") : t("sortUpdated")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setSortBy("updatedAt")}>
                      {t("sortUpdated")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSortBy("createdAt")}>
                      {t("sortCreated")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSortBy("title")}>
                      {t("sortTitle")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
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
                    </DropdownMenuContent>
                  </DropdownMenu>
                )
              )}
            </>
          }
        />

        <div className="mb-4 rounded-xl border bg-card/80 p-3">
          <SearchBar ref={searchRef} value={searchQuery} onChange={setSearchQuery} />
        </div>

        <div className="space-y-4">
          {isTrash ? (
            <>
              <TrashList refreshKey={refreshKey} />
            </>
          ) : (
            <>
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
              />
              {isFavorites && (
                <OrgFavoritesList
                  searchQuery={searchQuery}
                  refreshKey={refreshKey}
                />
              )}
            </>
          )}
        </div>
      </div>

      <PasswordNewDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onSaved={handleDataChange}
        entryType={newEntryType}
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
