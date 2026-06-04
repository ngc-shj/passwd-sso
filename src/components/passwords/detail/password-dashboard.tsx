"use client";

import { useState, useRef, useEffect, Fragment, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { SearchBar } from "@/components/layout/search-bar";
import { PasswordList, type SortOption, type PasswordListHandle, type DisplayEntry } from "@/components/passwords/detail/password-list";
import { TrashList, type TrashListHandle } from "@/components/passwords/shared/trash-list";
import { PasswordNewDialog } from "@/components/passwords/dialogs/personal-password-new-dialog";
import { EntryListHeader } from "@/components/passwords/entry/entry-list-header";
import { EntrySortMenu } from "@/components/passwords/entry/entry-sort-menu";
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
import { Plus, KeyRound, FileText, CreditCard, IdCard, Fingerprint, Star, Archive, Trash2, CheckSquare, Landmark, KeySquare, FolderOpen, Tag, Terminal } from "lucide-react";
import type { EntryTypeValue } from "@/lib/constants";
import { ENTRY_TYPE } from "@/lib/constants";
import { MAX_BULK_SELECTION } from "@/lib/bulk-selection-helpers";
import { usePersonalFolders } from "@/hooks/personal/use-personal-folders";
import { usePersonalTags } from "@/hooks/personal/use-personal-tags";
import { buildFolderPath } from "@/lib/folder/folder-path";
import { buildTagPath } from "@/lib/format/tag-tree";
import type { TagData } from "@/components/tags/tag-input";
import { VAULT_DATA_CHANGED_EVENT, notifyVaultDataChanged } from "@/lib/events";
import { isOverlayActive } from "@/components/extension/auto-extension-connect";
import { useVault } from "@/lib/vault/vault-context";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { MasterDetailShell } from "@/components/passwords/detail/master-detail-shell";
import { PasswordDetailPane } from "@/components/passwords/detail/password-detail-pane";
import { usePasswordEntryDetail } from "@/hooks/vault/use-password-entry-detail";
import { buildPersonalGetDetail } from "@/lib/vault/build-personal-get-detail";
import { PasswordEditDialogLoader } from "@/components/passwords/dialogs/personal-password-edit-dialog-loader";
import { ShareDialog } from "@/components/share/share-dialog";
import { toast } from "sonner";

// Static icon map — created once at module scope to avoid re-creation on every render
const ENTRY_TYPE_ICONS: Record<string, React.ReactNode> = {
  LOGIN: <KeyRound className="h-6 w-6" />,
  SECURE_NOTE: <FileText className="h-6 w-6" />,
  CREDIT_CARD: <CreditCard className="h-6 w-6" />,
  IDENTITY: <IdCard className="h-6 w-6" />,
  PASSKEY: <Fingerprint className="h-6 w-6" />,
  BANK_ACCOUNT: <Landmark className="h-6 w-6" />,
  SOFTWARE_LICENSE: <KeySquare className="h-6 w-6" />,
  SSH_KEY: <Terminal className="h-6 w-6" />,
};

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
  const tCard = useTranslations("PasswordCard");

  const [searchQuery, setSearchQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [sortBy, setSortBy] = useState<SortOption>("updatedAt");
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newEntryType, setNewEntryType] = useState<EntryTypeValue>(ENTRY_TYPE.LOGIN);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [allSelected, setAllSelected] = useState(false);
  const [selectionAtLimit, setSelectionAtLimit] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const passwordListRef = useRef<PasswordListHandle>(null);
  const trashListRef = useRef<TrashListHandle>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);

  // C4: single source of truth for the active (selected) entry.
  // INV-C1.5: this state lives INSIDE PasswordDashboard (under VaultGate) — NOT hoisted above VaultGate.
  const [activeEntry, setActiveEntry] = useState<DisplayEntry | null>(null);

  // C5: layout mode from matchMedia (SSR-safe, INV-C5.3/C5.5).
  const layoutMode = useLayoutMode();

  // Vault context for personal decrypt + detail pane.
  const { encryptionKey, userId, status: vaultStatus } = useVault();

  // Pane-level detail dialogs (edit, share) — owned here, not duplicated in PasswordCard.
  const [paneEditOpen, setPaneEditOpen] = useState(false);
  const [paneShareOpen, setPaneShareOpen] = useState(false);
  const [paneShareData, setPaneShareData] = useState<Record<string, unknown> | undefined>(undefined);

  // Build the getDetail closure for the active entry (personal path).
  // INV-C1.7: all field-mapping lives in buildPersonalGetDetail, not the hook.
  // Memoized so the closure reference is stable until activeEntry.id / encryptionKey changes.
  const getDetail = useMemo(
    () =>
      activeEntry && encryptionKey
        ? buildPersonalGetDetail(activeEntry, { encryptionKey, userId })
        : async (_id: string): Promise<never> => { throw new Error("No active entry or vault locked"); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEntry?.id, encryptionKey, userId],
  );

  // C1 hook — manages fetch/decrypt lifecycle for the active entry in the detail pane.
  const {
    detailData,
    loading: detailLoading,
    error: detailError,
    invalidate: invalidateDetail,
  } = usePasswordEntryDetail(
    activeEntry?.id ?? null,
    { getDetail, vaultStatus },
  );

  // Debounce ref for keyboard arrow-nav (INV-C7.4).
  const arrowNavDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { folders } = usePersonalFolders();
  const { tags } = usePersonalTags();

  const isTrash = view === "trash";
  const isFavorites = view === "favorites";
  const isArchive = view === "archive";
  const contextualEntryType = entryType && Object.values(ENTRY_TYPE).includes(entryType as EntryTypeValue)
    ? (entryType as EntryTypeValue)
    : null;

  // useTranslations output is stable across renders within the same locale,
  // but the object literal itself would be re-created each render without useMemo.
  const ENTRY_TYPE_TITLES = useMemo<Record<string, string>>(() => ({
    LOGIN: t("catLogin"),
    SECURE_NOTE: t("catSecureNote"),
    CREDIT_CARD: t("catCreditCard"),
    IDENTITY: t("catIdentity"),
    PASSKEY: t("catPasskey"),
    BANK_ACCOUNT: t("catBankAccount"),
    SOFTWARE_LICENSE: t("catSoftwareLicense"),
    SSH_KEY: t("catSshKey"),
  }), [t]);

  const folderLabel = folderId ? buildFolderPath(folderId, folders) : null;
  const matchedTag = tagId ? tags.find((tag) => tag.id === tagId) : undefined;
  const tagLabel = tagId ? buildTagPath(tagId, tags) : null;

  const subtitle = isTrash
    ? t("trash")
    : isFavorites
      ? t("favorites")
      : isArchive
        ? t("archive")
        : entryType && ENTRY_TYPE_TITLES[entryType]
          ? ENTRY_TYPE_TITLES[entryType]
          : folderLabel ?? tagLabel ?? (folderId || tagId ? " " : t("passwords"));

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

  // INV-C4.2: reset selection mode AND activeEntry when view changes.
  // Done during render (NOT in an effect) so the pane clears in the same frame as the view change.
  const viewKey = `${view}|${tagId}|${folderId}|${entryType}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey);
    setSelectionMode(false);
    setActiveEntry(null); // INV-C4.2: clear pane on view change
  }

  const handleSelectedCountChange = useCallback((count: number, isAllSelected: boolean, isAtLimit: boolean) => {
    setSelectedCount(count);
    setAllSelected(isAllSelected);
    setSelectionAtLimit(isAtLimit);
  }, []);

  const activeListRef = isTrash ? trashListRef : passwordListRef;

  // INV-C4.3: clear pane when a single-entry removal is signalled from the list.
  const handleEntryRemoved = useCallback((id: string) => {
    setActiveEntry((prev) => (prev?.id === id ? null : prev));
  }, []);

  // Listen for vault-data-changed (import, etc.)
  useEffect(() => {
    const handler = () => setRefreshKey((k) => k + 1);
    window.addEventListener(VAULT_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(VAULT_DATA_CHANGED_EVENT, handler);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Suppress all shortcuts while a full-screen overlay is active
      if (isOverlayActive()) return;

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

  const handleDataChange = useCallback(() => {
    setRefreshKey((k) => k + 1);
    notifyVaultDataChanged();
  }, []);

  // Keyboard navigation: we keep refs to the latest visible entries and active entry
  // so that debounced setTimeout callbacks read current values without stale closures.
  const visibleEntriesRef = useRef<DisplayEntry[]>([]);
  const activeEntryRef = useRef<DisplayEntry | null>(activeEntry);
  // Keep activeEntryRef in sync with activeEntry state (renders are the only update point).
  activeEntryRef.current = activeEntry;

  // Refined keyboard handler that uses visibleEntriesRef.
  const handleListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (layoutMode !== "master-detail") return;
    if (selectionMode) return; // INV-C4.4

    const target = e.target as HTMLElement;
    const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if (e.key === "Escape") {
      listPaneRef.current?.focus();
      e.stopPropagation();
      return;
    }

    if (inInput) return; // INV-C7.2

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Capture key before the synthetic event is recycled.
      const direction = e.key;
      if (arrowNavDebounceRef.current) clearTimeout(arrowNavDebounceRef.current);
      // Debounce (~150ms) so holding ↓ doesn't fire N concurrent getDetail calls (INV-C7.4).
      arrowNavDebounceRef.current = setTimeout(() => {
        arrowNavDebounceRef.current = null;
        const listEl = listPaneRef.current;
        if (!listEl) return;
        // Use PasswordRow's role="option" elements as the ordered visible list.
        // Each row's aria-current="true" marks the active one.
        const rows = Array.from(listEl.querySelectorAll<HTMLElement>("[role='option']"));
        if (rows.length === 0) return;
        const currentActive = activeEntryRef.current;
        const currentIdx = currentActive
          ? rows.findIndex((r) => r.getAttribute("aria-current") === "true")
          : -1;
        const nextIdx = direction === "ArrowDown"
          ? Math.min(currentIdx + 1, rows.length - 1)
          : Math.max(currentIdx - 1, 0);
        // Navigate using the visibleEntriesRef for DisplayEntry lookup (populated by PasswordList).
        const entries = visibleEntriesRef.current;
        const next = entries[nextIdx];
        if (next) setActiveEntry(next);
      }, 150);
      return;
    }

    if (e.key === "Enter" || e.key === "Tab") {
      const detailEl = listPaneRef.current?.parentElement?.querySelector<HTMLElement>("[data-testid='master-detail-detail']");
      detailEl?.focus();
      e.preventDefault();
    }
  }, [layoutMode, selectionMode]);

  // The pane needs a share handler.
  const handlePaneShare = useCallback(async () => {
    if (!activeEntry || !encryptionKey) return;
    try {
      const detail = await buildPersonalGetDetail(activeEntry, { encryptionKey, userId })(activeEntry.id);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { totp: _t, passwordHistory: _ph, id: _id, requireReprompt: _rp, ...safe } = detail;
      setPaneShareData(safe as Record<string, unknown>);
      setPaneShareOpen(true);
    } catch {
      toast.error(tCard("networkError"));
    }
  }, [activeEntry, encryptionKey, userId, tCard]);

  const listSlot = (
    <div
      ref={listPaneRef}
      tabIndex={layoutMode === "master-detail" ? 0 : undefined}
      onKeyDown={handleListKeyDown}
      className="outline-none h-full"
    >
      <div className="space-y-4 p-2">
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
          activeEntryId={activeEntry?.id ?? null}
          onActivate={setActiveEntry}
          onEntryRemoved={handleEntryRemoved}
          layoutMode={layoutMode}
          onVisibleEntriesChange={(entries) => { visibleEntriesRef.current = entries; }}
        />
      </div>
    </div>
  );

  const detailSlot = (
    <div className="h-full p-4">
      <PasswordDetailPane
        key={activeEntry?.id ?? "none"}
        entryId={activeEntry?.id ?? null}
        detailData={detailData}
        loading={detailLoading}
        error={detailError}
        onEdit={activeEntry ? () => setPaneEditOpen(true) : undefined}
        onRefresh={() => { invalidateDetail(); handleDataChange(); }}
      />
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4 md:p-6">
      <div className={layoutMode === "master-detail" ? "w-full" : "mx-auto max-w-4xl w-full"}>
        <EntryListHeader
          icon={headerIcon}
          title={isPrimaryScopeLabel ? subtitle : t("personalVault")}
          subtitle={subtitle}
          showSubtitle={!isPrimaryScopeLabel}
          truncateStart={!!folderLabel || !!tagLabel}
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
                  {selectionAtLimit && (
                    <span className="text-xs text-amber-600 whitespace-nowrap">
                      {tl("selectionLimit", { max: MAX_BULK_SELECTION })}
                    </span>
                  )}
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
                        <DropdownMenuItem onClick={() => { setNewEntryType(ENTRY_TYPE.SSH_KEY); setNewDialogOpen(true); }}>
                          <Terminal className="h-4 w-4 mr-2" />
                          {t("newSshKey")}
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
      </div>

      {/* Main content area — MasterDetailShell handles layout mode (C5) */}
      <div className={[
        "flex-1 min-h-0",
        layoutMode === "master-detail" ? "overflow-hidden" : "mx-auto max-w-4xl w-full",
      ].join(" ")}>
        {isTrash ? (
          <div className="space-y-4">
            <TrashList
              refreshKey={refreshKey}
              searchQuery={searchQuery}
              selectionMode={selectionMode}
              onSelectedCountChange={handleSelectedCountChange}
              selectAllRef={trashListRef}
            />
          </div>
        ) : (
          <MasterDetailShell
            layoutMode={layoutMode}
            activeEntryId={activeEntry?.id ?? null}
            listSlot={listSlot}
            detailSlot={detailSlot}
          />
        )}
      </div>

      <PasswordNewDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onSaved={handleDataChange}
        entryType={newEntryType}
        defaultFolderId={folderId ?? null}
        defaultTags={defaultTagData}
      />

      {/* Detail pane edit dialog — owned here, not duplicated from PasswordCard (Commonization). */}
      {activeEntry && (
        <PasswordEditDialogLoader
          id={activeEntry.id}
          open={paneEditOpen}
          onOpenChange={setPaneEditOpen}
          onSaved={() => {
            invalidateDetail();
            handleDataChange();
          }}
        />
      )}

      {/* Detail pane share dialog */}
      {activeEntry && (
        <ShareDialog
          open={paneShareOpen}
          onOpenChange={setPaneShareOpen}
          passwordEntryId={activeEntry.id}
          decryptedData={paneShareData}
          entryType={activeEntry.entryType}
        />
      )}

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
