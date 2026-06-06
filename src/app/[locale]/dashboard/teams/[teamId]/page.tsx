"use client";

import { useEffect, useState, useRef, use } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { EntryListHeader } from "@/components/passwords/entry/entry-list-header";
import { EntrySortMenu } from "@/components/passwords/entry/entry-sort-menu";
import { SearchBar } from "@/components/layout/search-bar";
import { EntryListView, type EntryListHandle } from "@/components/passwords/detail/entry-list-view";
import {
  NORMAL_VIEW,
  FAVORITES_VIEW,
  ARCHIVE_VIEW,
  TRASH_VIEW,
} from "@/components/passwords/detail/entry-list-view-descriptors";
import { useTeamVaultListAdapter } from "@/lib/vault/team-vault-list-adapter";
import type { TeamDisplayEntry } from "@/types/team-display-entry";
import { TeamNewDialog } from "@/components/team/management/team-new-dialog";
import { TeamEditDialogLoader } from "@/components/team/management/team-edit-dialog-loader";
import { TeamRoleBadge } from "@/components/team/management/team-role-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, KeyRound, FileText, CreditCard, IdCard, Fingerprint, Star, Archive, Trash2, Clock, Landmark, KeySquare, CheckSquare, FolderOpen, Tag, Terminal } from "lucide-react";
import { ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { EntrySortOption } from "@/lib/vault/entry-sort";
import { buildFolderPath } from "@/lib/folder/folder-path";
import { buildTagPath } from "@/lib/format/tag-tree";
import type { FolderItem } from "@/components/folders/folder-tree";
import { useTeamVault } from "@/lib/team/team-vault-context";
import { MAX_BULK_SELECTION } from "@/lib/bulk-selection-helpers";
import { fetchApi } from "@/lib/url-helpers";
import { useLayoutMode } from "@/hooks/use-layout-mode";

interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  passwordCount: number;
}

export default function TeamDashboardPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const searchParams = useSearchParams();
  const activeTagId = searchParams.get("tag");
  const activeFolderId = searchParams.get("folder");
  const activeEntryType = searchParams.get("type");
  const activeScope = searchParams.get("scope");
  const t = useTranslations("Team");
  const tDash = useTranslations("Dashboard");
  const tl = useTranslations("PasswordList");
  const { getTeamEncryptionKey } = useTeamVault();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<EntrySortOption>("updatedAt");
  const [formOpen, setFormOpen] = useState(false);
  const [newEntryType, setNewEntryType] = useState<EntryTypeValue>(ENTRY_TYPE.LOGIN);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);

  // Header selection-mode mirror (EntryListView owns the actual selection state).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [allSelected, setAllSelected] = useState(false);
  const [selectionAtLimit, setSelectionAtLimit] = useState(false);
  const listRef = useRef<EntryListHandle>(null);

  const isTeamArchive = activeScope === "archive";
  const isTeamTrash = activeScope === "trash";
  const isTeamFavorites = activeScope === "favorites";
  const isTeamSpecialView = isTeamArchive || isTeamTrash;

  const layoutMode = useLayoutMode();
  const isMasterDetail = layoutMode === "master-detail";

  // C6 — the team vault adapter the shared EntryListView mounts.
  const adapter = useTeamVaultListAdapter(teamId, team?.role ?? "");

  // Key-pending banner: probe the team key directly so we can show the team-specific
  // "key being distributed" card instead of the generic gate (preserves prior UX).
  const [keyPending, setKeyPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getTeamEncryptionKey(teamId)
      .then((k) => { if (!cancelled) setKeyPending(!k); })
      .catch(() => { if (!cancelled) setKeyPending(false); });
    return () => { cancelled = true; };
    // Key availability is independent of data mutations — do NOT depend on refreshKey,
    // which would risk flashing the banner over the list after a mutation.
  }, [teamId, getTeamEncryptionKey]);

  const [teamFolders, setTeamFolders] = useState<FolderItem[]>([]);
  const [teamTags, setTeamTags] = useState<{ id: string; name: string; color?: string | null; parentId?: string | null }[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const [foldersRes, tagsRes] = await Promise.all([
          fetchApi(apiPath.teamFolders(teamId)),
          fetchApi(apiPath.teamTags(teamId)),
        ]);
        const f = foldersRes.ok ? await foldersRes.json() : [];
        const tg = tagsRes.ok ? await tagsRes.json() : [];
        if (Array.isArray(f)) setTeamFolders(f);
        if (Array.isArray(tg)) setTeamTags(tg);
      } catch {
        // best-effort — leave folders/tags empty
      }
    })();
  }, [teamId]);

  // INV-C4.2: reset the header's selection mirror when the view changes (during render).
  // EntryListView clears its own activeEntry + selection on view change (INV-F1).
  const viewKey = `${activeScope}|${activeTagId}|${activeFolderId}|${activeEntryType}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey);
    setSelectionMode(false);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchApi(apiPath.teamById(teamId));
        if (cancelled) return;
        if (!res.ok) { setTeam(null); setLoadError(true); return; }
        setTeam(await res.json());
        setLoadError(false);
      } catch {
        if (!cancelled) { setTeam(null); setLoadError(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  // ESC exits selection mode (EntryListView owns the list's own keydown handling).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectionMode) {
        setSelectionMode(false);
        listRef.current?.exitSelectionMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectionMode]);

  // Plain functions — the React Compiler memoizes them; manual useCallback here
  // tripped its preserve-manual-memoization check.
  const handleSelectedCountChange = (count: number, isAllSelected: boolean, isAtLimit: boolean) => {
    setSelectedCount(count);
    setAllSelected(isAllSelected);
    setSelectionAtLimit(isAtLimit);
  };

  const handleRequestEdit = (entry: TeamDisplayEntry) => {
    setEditEntryId(entry.id);
    setFormOpen(true);
  };

  const contextualEntryType = activeEntryType && Object.values(ENTRY_TYPE).includes(activeEntryType as EntryTypeValue)
    ? (activeEntryType as EntryTypeValue)
    : null;
  const activeCategoryLabel = activeEntryType
    ? ({
        [ENTRY_TYPE.LOGIN]: tDash("catLogin"),
        [ENTRY_TYPE.SECURE_NOTE]: tDash("catSecureNote"),
        [ENTRY_TYPE.CREDIT_CARD]: tDash("catCreditCard"),
        [ENTRY_TYPE.IDENTITY]: tDash("catIdentity"),
        [ENTRY_TYPE.PASSKEY]: tDash("catPasskey"),
        [ENTRY_TYPE.BANK_ACCOUNT]: tDash("catBankAccount"),
        [ENTRY_TYPE.SOFTWARE_LICENSE]: tDash("catSoftwareLicense"),
        [ENTRY_TYPE.SSH_KEY]: tDash("catSshKey"),
      } as Record<string, string>)[activeEntryType] ?? activeEntryType
    : null;
  const folderLabel = activeFolderId ? buildFolderPath(activeFolderId, teamFolders) : null;
  const matchedTag = activeTagId ? teamTags.find((tg) => tg.id === activeTagId) : null;
  const tagLabel = activeTagId ? buildTagPath(activeTagId, teamTags) : null;
  const subtitle = isTeamTrash
    ? t("trash")
    : isTeamArchive
      ? t("archive")
      : isTeamFavorites
        ? t("favorites")
        : activeCategoryLabel
          ?? folderLabel ?? tagLabel
          ?? (activeFolderId || activeTagId ? " " : t("passwords"));

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
  const headerIcon = isTeamTrash
    ? <Trash2 className="h-6 w-6" />
    : isTeamArchive
      ? <Archive className="h-6 w-6" />
      : isTeamFavorites
        ? <Star className="h-6 w-6" />
        : activeEntryType && ENTRY_TYPE_ICONS[activeEntryType]
          ? ENTRY_TYPE_ICONS[activeEntryType]
          : activeFolderId
            ? <FolderOpen className="h-6 w-6" />
            : activeTagId
              ? <Tag className="h-6 w-6" />
              : <KeyRound className="h-6 w-6" />;

  const isTeamAll =
    !isTeamTrash && !isTeamArchive && !isTeamFavorites && !activeCategoryLabel && !activeTagId && !activeFolderId;
  const isPrimaryScopeLabel =
    isTeamTrash || isTeamArchive || isTeamFavorites || isTeamAll || !!activeCategoryLabel || Boolean(activeTagId || activeFolderId);

  const canCreate = adapter.permissions.canCreate;
  const canDelete = adapter.permissions.canDelete;

  const descriptor = isTeamTrash
    ? TRASH_VIEW
    : isTeamArchive
      ? ARCHIVE_VIEW
      : isTeamFavorites
        ? FAVORITES_VIEW
        : NORMAL_VIEW;
  // Archive/trash ignore tag/folder/type filters (matching the prior team behavior).
  const query = isTeamSpecialView
    ? { tagId: null, folderId: null, entryType: null }
    : { tagId: activeTagId, folderId: activeFolderId, entryType: activeEntryType };

  if (loadError) {
    return (
      <div className="flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-4xl">
          <Card className="rounded-xl border bg-card/80 p-6">
            <div className="flex flex-col items-start gap-3">
              <h1 className="text-xl font-semibold">{t("forbidden")}</h1>
              <p className="text-sm text-muted-foreground">{t("noTeamsDesc")}</p>
              <Button variant="ghost" asChild>
                <Link href="/dashboard/teams">{t("manage")}</Link>
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const newEntryItems: { type: EntryTypeValue; icon: React.ReactNode; label: string }[] = [
    { type: ENTRY_TYPE.LOGIN, icon: <KeyRound className="mr-2 h-4 w-4" />, label: t("newPassword") },
    { type: ENTRY_TYPE.SECURE_NOTE, icon: <FileText className="mr-2 h-4 w-4" />, label: t("newSecureNote") },
    { type: ENTRY_TYPE.CREDIT_CARD, icon: <CreditCard className="mr-2 h-4 w-4" />, label: t("newCreditCard") },
    { type: ENTRY_TYPE.IDENTITY, icon: <IdCard className="mr-2 h-4 w-4" />, label: t("newIdentity") },
    { type: ENTRY_TYPE.PASSKEY, icon: <Fingerprint className="mr-2 h-4 w-4" />, label: t("newPasskey") },
    { type: ENTRY_TYPE.BANK_ACCOUNT, icon: <Landmark className="mr-2 h-4 w-4" />, label: t("newBankAccount") },
    { type: ENTRY_TYPE.SOFTWARE_LICENSE, icon: <KeySquare className="mr-2 h-4 w-4" />, label: t("newSoftwareLicense") },
    { type: ENTRY_TYPE.SSH_KEY, icon: <Terminal className="mr-2 h-4 w-4" />, label: t("newSshKey") },
  ];

  return (
    <div
      className={[
        "flex flex-col min-h-0 p-4 md:p-6",
        isMasterDetail ? "h-full" : "flex-1",
      ].join(" ")}
    >
      <div className={isMasterDetail ? "w-full" : "mx-auto max-w-4xl w-full"}>
        <EntryListHeader
          icon={headerIcon}
          title={isPrimaryScopeLabel ? subtitle : (team?.name ?? "...")}
          subtitle={subtitle}
          showSubtitle={!isPrimaryScopeLabel}
          truncateStart={!!folderLabel || !!tagLabel}
          titleExtra={!isPrimaryScopeLabel && team ? <TeamRoleBadge role={team.role} /> : null}
          actions={
            selectionMode ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => listRef.current?.toggleSelectAll(Boolean(v))}
                    aria-label={tDash("selectAll")}
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {selectedCount > 0
                      ? tl("selectedCount", { count: selectedCount })
                      : tDash("selectAll")}
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
                  onClick={() => {
                    setSelectionMode(false);
                    listRef.current?.exitSelectionMode();
                  }}
                >
                  {tDash("close")}
                </Button>
              </div>
            ) : (
              <>
                {canDelete && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectionMode(true);
                      listRef.current?.enterSelectionMode();
                    }}
                  >
                    <CheckSquare className="h-4 w-4 mr-2" />
                    {tDash("select")}
                  </Button>
                )}
                {canCreate && !isTeamSpecialView && (
                  contextualEntryType ? (
                    <Button
                      onClick={() => {
                        setEditEntryId(null);
                        setNewEntryType(contextualEntryType);
                        setFormOpen(true);
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {t("newItem")}
                    </Button>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button>
                          <Plus className="mr-2 h-4 w-4" />
                          {t("newItem")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {newEntryItems.map((item) => (
                          <DropdownMenuItem
                            key={item.type}
                            onClick={() => { setEditEntryId(null); setNewEntryType(item.type); setFormOpen(true); }}
                          >
                            {item.icon}
                            {item.label}
                          </DropdownMenuItem>
                        ))}
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
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
          </div>
          <EntrySortMenu
            sortBy={sortBy}
            onSortByChange={setSortBy}
            labels={{
              updated: tDash("sortUpdated"),
              created: tDash("sortCreated"),
              title: tDash("sortTitle"),
            }}
          />
        </div>
      </div>

      {/* Main content area — every view delegates to EntryListView (C8). */}
      <div className={[
        "flex-1 min-h-0",
        isMasterDetail ? "overflow-hidden" : "mx-auto max-w-4xl w-full",
      ].join(" ")}>
        {keyPending ? (
          <Card className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
            <div className="flex items-start gap-3">
              <Clock className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-medium text-amber-800 dark:text-amber-300">{t("keyPendingTitle")}</p>
                <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">{t("keyPendingDesc")}</p>
              </div>
            </div>
          </Card>
        ) : (
          <EntryListView<TeamDisplayEntry>
            adapter={adapter}
            descriptor={descriptor}
            query={query}
            searchQuery={searchQuery}
            sortBy={sortBy}
            refreshKey={refreshKey}
            onSelectedCountChange={handleSelectedCountChange}
            listRef={listRef}
            onDataChange={() => setRefreshKey((k) => k + 1)}
            onRequestEdit={handleRequestEdit}
          />
        )}
      </div>

      {formOpen && !editEntryId && (
        <TeamNewDialog
          teamId={teamId}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={() => setRefreshKey((k) => k + 1)}
          entryType={newEntryType}
          defaultFolderId={activeFolderId ?? null}
          defaultTags={matchedTag ? [{ id: matchedTag.id, name: matchedTag.name, color: matchedTag.color ?? null }] : undefined}
        />
      )}
      {formOpen && editEntryId && (
        <TeamEditDialogLoader
          teamId={teamId}
          id={editEntryId}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={() => setRefreshKey((k) => k + 1)}
          defaultFolderId={activeFolderId ?? null}
          defaultTags={matchedTag ? [{ id: matchedTag.id, name: matchedTag.name, color: matchedTag.color ?? null }] : undefined}
        />
      )}
    </div>
  );
}
