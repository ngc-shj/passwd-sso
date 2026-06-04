"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { PasswordCard } from "@/components/passwords/detail/password-card";
import { PasswordRow } from "@/components/passwords/detail/password-row";
import { MasterDetailShell } from "@/components/passwords/detail/master-detail-shell";
import { PasswordDetailPane } from "@/components/passwords/detail/password-detail-pane";
import { EntryListHeader } from "@/components/passwords/entry/entry-list-header";
import { EntrySortMenu } from "@/components/passwords/entry/entry-sort-menu";
import { SearchBar } from "@/components/layout/search-bar";
import type { InlineDetailData } from "@/components/passwords/detail/password-detail-inline";
import { mapDecryptedBlobToDetailFields } from "@/lib/vault/map-detail-fields";
import { TeamNewDialog } from "@/components/team/management/team-new-dialog";
import { TeamEditDialogLoader } from "@/components/team/management/team-edit-dialog-loader";
import { TeamArchivedList, type TeamArchivedListHandle } from "@/components/team/management/team-archived-list";
import { TeamTrashList, type TeamTrashListHandle } from "@/components/team/management/team-trash-list";
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
import { TEAM_ROLE, ENTRY_TYPE, VAULT_STATUS, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { compareEntriesWithFavorite, type EntrySortOption } from "@/lib/vault/entry-sort";
import { buildFolderPath } from "@/lib/folder/folder-path";
import { buildTagPath } from "@/lib/format/tag-tree";
import type { FolderItem } from "@/components/folders/folder-tree";
import { useTeamVault } from "@/lib/team/team-vault-context";
import { decryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { useBulkSelection } from "@/hooks/bulk/use-bulk-selection";
import { MAX_BULK_SELECTION } from "@/lib/bulk-selection-helpers";
import { useBulkAction } from "@/hooks/bulk/use-bulk-action";
import { useTeamEntryMutations } from "@/hooks/team/use-team-entry-mutations";
import { EntryListShell } from "@/components/bulk/entry-list-shell";
import { fetchApi } from "@/lib/url-helpers";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { usePasswordEntryDetail } from "@/hooks/vault/use-password-entry-detail";
import { useEntryActions } from "@/hooks/vault/use-entry-actions";

interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  passwordCount: number;
}

interface TeamPasswordEntry {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  relyingPartyId: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  softwareName: string | null;
  licensee: string | null;
  keyType: string | null;
  fingerprint: string | null;
  requireReprompt: boolean;
  expiresAt: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { id: string; name: string | null; email: string | null; image: string | null };
  updatedBy: { id: string; name: string | null; email: string | null };
  createdAt: string;
  updatedAt: string;
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
  const { getTeamEncryptionKey, getEntryDecryptionKey } = useTeamVault();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [passwords, setPasswords] = useState<TeamPasswordEntry[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [keyPending, setKeyPending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<EntrySortOption>("updatedAt");
  const [formOpen, setFormOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newEntryType, setNewEntryType] = useState<EntryTypeValue>(ENTRY_TYPE.LOGIN);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const archivedListRef = useRef<TeamArchivedListHandle>(null);
  const trashListRef = useRef<TeamTrashListHandle>(null);
  const [childSelectedCount, setChildSelectedCount] = useState(0);
  const [childAllSelected, setChildAllSelected] = useState(false);
  const [childAtLimit, setChildAtLimit] = useState(false);
  const isTeamArchive = activeScope === "archive";
  const isTeamTrash = activeScope === "trash";
  const isTeamFavorites = activeScope === "favorites";
  const isTeamSpecialView = isTeamArchive || isTeamTrash;

  // 3-pane layout mode — "master-detail" at lg+, "accordion" below (INV-C5.5).
  const layoutMode = useLayoutMode();

  // Active entry in the detail pane (single source of truth, INV-C4.2).
  const [activeEntry, setActiveEntry] = useState<TeamPasswordEntry | null>(null);

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

  // Reset selection mode and active entry when view changes (during render, INV-C4.2).
  const viewKey = `${activeScope}|${activeTagId}|${activeFolderId}|${activeEntryType}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey);
    setSelectionMode(false);
    setActiveEntry(null);
  }

  const fetchTeam = async (): Promise<boolean> => {
    try {
      const res = await fetchApi(apiPath.teamById(teamId));
      if (!res.ok) {
        setTeam(null);
        setLoadError(true);
        return false;
      }
      const data = await res.json();
      setTeam(data);
      setLoadError(false);
      return true;
    } catch {
      setTeam(null);
      setLoadError(true);
      return false;
    }
  };

  const fetchPasswords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (activeTagId) params.set("tag", activeTagId);
      if (activeFolderId) params.set("folder", activeFolderId);
      if (activeEntryType) params.set("type", activeEntryType);
      if (isTeamFavorites) params.set("favorites", "true");
      const qs = params.toString();
      const url = `${apiPath.teamPasswords(teamId)}${qs ? `?${qs}` : ""}`;
      const res = await fetchApi(url);
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const teamKey = await getTeamEncryptionKey(teamId);
      if (!teamKey) {
        setKeyPending(true);
        setPasswords([]);
        return;
      }
      setKeyPending(false);

      const decrypted = await Promise.all(
        data.map(async (entry: Record<string, unknown>) => {
          try {
            const entryId = entry.id as string;
            const itemKeyVersion = (entry.itemKeyVersion as number) ?? 0;
            const decryptKey = await getEntryDecryptionKey(teamId, entryId, {
              itemKeyVersion,
              encryptedItemKey: entry.encryptedItemKey as string | undefined,
              itemKeyIv: entry.itemKeyIv as string | undefined,
              itemKeyAuthTag: entry.itemKeyAuthTag as string | undefined,
              teamKeyVersion: (entry.teamKeyVersion as number) ?? 1,
            });
            const aad = buildTeamEntryAAD(teamId, entryId, "overview", itemKeyVersion);
            const json = await decryptData(
              {
                ciphertext: entry.encryptedOverview as string,
                iv: entry.overviewIv as string,
                authTag: entry.overviewAuthTag as string,
              },
              decryptKey,
              aad,
            );
            const overview = JSON.parse(json);
            return {
              id: entry.id,
              entryType: entry.entryType,
              title: overview.title ?? "",
              username: overview.username ?? null,
              urlHost: overview.urlHost ?? null,
              snippet: overview.snippet ?? null,
              brand: overview.brand ?? null,
              lastFour: overview.lastFour ?? null,
              cardholderName: overview.cardholderName ?? null,
              fullName: overview.fullName ?? null,
              idNumberLast4: overview.idNumberLast4 ?? null,
              relyingPartyId: overview.relyingPartyId ?? null,
              bankName: overview.bankName ?? null,
              accountNumberLast4: overview.accountNumberLast4 ?? null,
              softwareName: overview.softwareName ?? null,
              licensee: overview.licensee ?? null,
              keyType: overview.keyType ?? null,
              fingerprint: overview.fingerprint ?? null,
              requireReprompt: entry.requireReprompt ?? false,
              expiresAt: entry.expiresAt ?? null,
              isFavorite: entry.isFavorite,
              isArchived: entry.isArchived,
              tags: entry.tags,
              createdBy: entry.createdBy,
              updatedBy: entry.updatedBy,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            } as TeamPasswordEntry;
          } catch {
            return {
              id: entry.id as string,
              entryType: (entry.entryType ?? ENTRY_TYPE.LOGIN) as EntryTypeValue,
              title: "(decryption failed)",
              username: null,
              urlHost: null,
              snippet: null,
              brand: null,
              lastFour: null,
              cardholderName: null,
              fullName: null,
              idNumberLast4: null,
              relyingPartyId: null,
              bankName: null,
              accountNumberLast4: null,
              softwareName: null,
              licensee: null,
              keyType: null,
              fingerprint: null,
              requireReprompt: (entry.requireReprompt as boolean) ?? false,
              expiresAt: (entry.expiresAt as string | null) ?? null,
              isFavorite: entry.isFavorite as boolean,
              isArchived: entry.isArchived as boolean,
              tags: (entry.tags ?? []) as TeamPasswordEntry["tags"],
              createdBy: entry.createdBy as TeamPasswordEntry["createdBy"],
              updatedBy: entry.updatedBy as TeamPasswordEntry["updatedBy"],
              createdAt: entry.createdAt as string,
              updatedAt: entry.updatedAt as string,
            } as TeamPasswordEntry;
          }
        }),
      );
      setPasswords(decrypted);
    } catch {
      // network error
    } finally {
      setLoading(false);
    }
  }, [teamId, activeTagId, activeFolderId, activeEntryType, isTeamFavorites, getTeamEncryptionKey, getEntryDecryptionKey]);

  useEffect(() => {
    setLoadError(false);
    (async () => {
      const ok = await fetchTeam();
      if (ok && !isTeamSpecialView) fetchPasswords();
      else setLoading(false);
    })();
  }, [teamId, fetchPasswords, isTeamSpecialView]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCreate =
    team?.role === TEAM_ROLE.OWNER || team?.role === TEAM_ROLE.ADMIN || team?.role === TEAM_ROLE.MEMBER;
  const canDeletePerm = team?.role === TEAM_ROLE.OWNER || team?.role === TEAM_ROLE.ADMIN;
  const canEditPerm = canCreate;
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
          ?? (activeFolderId || activeTagId ? "\u00A0" : t("passwords"));
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
    !isTeamTrash &&
    !isTeamArchive &&
    !isTeamFavorites &&
    !activeCategoryLabel &&
    !activeTagId &&
    !activeFolderId;
  const isCategorySelected = !!activeCategoryLabel;
  const isFolderOrTagSelected = Boolean(activeTagId || activeFolderId);
  const isPrimaryScopeLabel =
    isTeamTrash ||
    isTeamArchive ||
    isTeamFavorites ||
    isTeamAll ||
    isCategorySelected ||
    isFolderOrTagSelected;

  const handleToggleFavorite = async (id: string, current: boolean) => {
    // Optimistic update — unfavoriting on the favorites view removes the entry (INV-C4.3).
    if (isTeamFavorites && current) {
      if (activeEntry?.id === id) setActiveEntry(null);
      setPasswords((prev) => prev.filter((e) => e.id !== id));
    } else {
      setPasswords((prev) =>
        prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
      );
    }
    try {
      const res = await fetchApi(apiPath.teamPasswordFavorite(teamId, id), {
        method: "POST",
      });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
  };

  const {
    toggleArchive: toggleArchiveMutation,
    deleteEntry: deleteEntryMutation,
    handleSaved,
  } = useTeamEntryMutations<TeamPasswordEntry>({
    teamId,
    setEntries: setPasswords,
    refetchEntries: fetchPasswords,
  });

  // Wrap mutations to clear activeEntry when the affected entry is selected (INV-C4.3).
  const handleToggleArchive = useCallback(
    (id: string, archived: boolean) => {
      if (activeEntry?.id === id) setActiveEntry(null);
      return toggleArchiveMutation(id, archived);
    },
    [activeEntry, toggleArchiveMutation],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (activeEntry?.id === id) setActiveEntry(null);
      return deleteEntryMutation(id);
    },
    [activeEntry, deleteEntryMutation],
  );

  const decryptFullBlob = useCallback(
    async (id: string, raw: Record<string, unknown>) => {
      const itemKeyVersion = (raw.itemKeyVersion as number) ?? 0;
      const decryptKey = await getEntryDecryptionKey(teamId, id, {
        itemKeyVersion,
        encryptedItemKey: raw.encryptedItemKey as string | undefined,
        itemKeyIv: raw.itemKeyIv as string | undefined,
        itemKeyAuthTag: raw.itemKeyAuthTag as string | undefined,
        teamKeyVersion: (raw.teamKeyVersion as number) ?? 1,
      });
      const aad = buildTeamEntryAAD(teamId, id, "blob", itemKeyVersion);
      const json = await decryptData(
        {
          ciphertext: raw.encryptedBlob as string,
          iv: raw.blobIv as string,
          authTag: raw.blobAuthTag as string,
        },
        decryptKey,
        aad,
      );
      return JSON.parse(json) as Record<string, unknown>;
    },
    [teamId, getEntryDecryptionKey],
  );

  const handleEdit = async (id: string) => {
    setEditEntryId(id);
    setFormOpen(true);
  };

  const createDetailFetcher = useCallback(
    (id: string, eType?: EntryTypeValue) => async (): Promise<InlineDetailData> => {
      const res = await fetchApi(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) {
        throw new Error("Failed");
      }
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      return {
        // Blob-sourced display fields via the shared mapper (commonized with the
        // personal/emergency paths so no per-entry-type field can be dropped here).
        ...mapDecryptedBlobToDetailFields(blob),
        // Caller-specific fields:
        id: raw.id,
        title: (blob.title as string) ?? undefined,
        entryType: eType,
        urlHost: null,
        passwordHistory: [],
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      };
    },
    [teamId, decryptFullBlob],
  );

  const createPasswordFetcher = useCallback(
    (id: string) => async (): Promise<string> => {
      const res = await fetchApi(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) {
        throw new Error("Failed");
      }
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      return (blob.password as string) ?? (blob.content as string) ?? "";
    },
    [teamId, decryptFullBlob],
  );

  const createUrlFetcher = useCallback(
    (id: string) => async (): Promise<string | null> => {
      const res = await fetchApi(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) {
        throw new Error("Failed");
      }
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      return (blob.url as string) ?? null;
    },
    [teamId, decryptFullBlob],
  );

  // Team vault status — mirrors personal vaultStatus; LOADING when the team key is
  // pending (not yet distributed), UNLOCKED once it is available (INV-C1.2/C1.3).
  const teamVaultStatus = keyPending ? VAULT_STATUS.LOADING : VAULT_STATUS.UNLOCKED;

  // getDetail for the active entry in the team detail pane.
  // Re-created only when activeEntry changes (the fetcher is entry-specific).
  const teamGetDetail = useCallback(
    (_id: string) =>
      activeEntry
        ? createDetailFetcher(activeEntry.id, activeEntry.entryType)()
        : Promise.reject(new Error("no active entry")),
    [activeEntry, createDetailFetcher],
  );

  const {
    detailData: teamDetailData,
    loading: teamDetailLoading,
    error: teamDetailError,
    invalidate: invalidateTeamDetail,
  } = usePasswordEntryDetail(activeEntry?.id ?? null, {
    getDetail: teamGetDetail,
    vaultStatus: teamVaultStatus,
  });

  // Row callbacks for master-detail rows — vault-agnostic via useEntryActions.
  const buildTeamRowCallbacks = useEntryActions((entry: TeamPasswordEntry) =>
    createDetailFetcher(entry.id, entry.entryType),
  );

  const filtered = passwords.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.title.toLowerCase().includes(q) ||
      p.username?.toLowerCase().includes(q) ||
      p.urlHost?.toLowerCase().includes(q) ||
      p.snippet?.toLowerCase().includes(q) ||
      p.brand?.toLowerCase().includes(q) ||
      p.lastFour?.toLowerCase().includes(q) ||
      p.cardholderName?.toLowerCase().includes(q) ||
      p.fullName?.toLowerCase().includes(q) ||
      p.idNumberLast4?.toLowerCase().includes(q) ||
      p.relyingPartyId?.toLowerCase().includes(q) ||
      p.bankName?.toLowerCase().includes(q) ||
      p.accountNumberLast4?.includes(q) ||
      p.softwareName?.toLowerCase().includes(q) ||
      p.licensee?.toLowerCase().includes(q) ||
      p.keyType?.toLowerCase().includes(q) ||
      p.fingerprint?.toLowerCase().includes(q)
    );
  });
  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesWithFavorite(a, b, sortBy)
  );

  // Bulk selection for main password list
  const entryIds = sortedFiltered.map((e) => e.id);
  const { selectedIds, allSelected, atLimit, toggleSelectOne, toggleSelectAll, clearSelection } =
    useBulkSelection({
      entryIds,
      selectionMode,
    });

  // Bulk action for main password list
  const {
    dialogOpen: bulkDialogOpen,
    setDialogOpen: setBulkDialogOpen,
    pendingAction,
    processing: bulkProcessing,
    requestAction,
    executeAction,
  } = useBulkAction({
    selectedIds,
    scope: { type: "team", teamId },
    t: tl,
    onSuccess: () => {
      clearSelection();
      fetchPasswords();
    },
  });

  // ESC key to exit selection mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectionMode) {
        setSelectionMode(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectionMode]);

  if (loadError) {
    return (
      <div className="flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-4xl">
          <Card className="rounded-xl border bg-card/80 p-6">
            <div className="flex flex-col items-start gap-3">
            <h1 className="text-xl font-semibold">{t("forbidden")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("noTeamsDesc")}
            </p>
            <Button variant="ghost" asChild>
              <Link href="/dashboard/teams">
                {t("manage")}
              </Link>
            </Button>
          </div>
          </Card>
        </div>
      </div>
    );
  }

  // Shared bulk action dialog — used by both layout modes.
  const bulkConfirmDialog = {
    open: bulkDialogOpen,
    onOpenChange: setBulkDialogOpen,
    title:
      pendingAction === "archive"
        ? tl("moveSelectedToArchive")
        : pendingAction === "unarchive"
          ? tl("moveSelectedToUnarchive")
          : tl("moveSelectedToTrash"),
    description:
      pendingAction === "archive"
        ? tl("bulkArchiveConfirm", { count: selectedIds.size })
        : pendingAction === "unarchive"
          ? tl("bulkUnarchiveConfirm", { count: selectedIds.size })
          : tl("bulkMoveConfirm", { count: selectedIds.size }),
    cancelLabel: tl("cancel"),
    confirmLabel: tl("confirm"),
    processing: bulkProcessing,
    onConfirm: () => void executeAction(),
  };

  const floatingBulkActions = (
    <>
      <Button variant="secondary" size="sm" onClick={() => requestAction("archive")}>
        <Archive className="h-4 w-4 mr-2" />
        {tl("moveSelectedToArchive")}
      </Button>
      <Button variant="destructive" size="sm" onClick={() => requestAction("trash")}>
        <Trash2 className="h-4 w-4 mr-2" />
        {tl("moveSelectedToTrash")}
      </Button>
    </>
  );

  // master-detail: h-full fills <main>'s definite flex height so panes scroll
  // independently (INV-C5.1). accordion: flex-1 keeps page-level scroll.
  // isTeamArchive in master-detail also needs h-full for TeamArchivedList's MasterDetailShell.
  const isMasterDetail = layoutMode === "master-detail";
  return (
    <div
      className={[
        "flex flex-col min-h-0 p-4 md:p-6",
        isMasterDetail && (!isTeamSpecialView || isTeamArchive) ? "h-full" : "flex-1",
      ].join(" ")}
    >
      {/* Header + search bar — always max-w-4xl, above the shell */}
      <div className={isMasterDetail && (!isTeamSpecialView || isTeamArchive) ? "w-full" : "mx-auto max-w-4xl w-full"}>
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
                    checked={isTeamSpecialView ? childAllSelected : allSelected}
                    onCheckedChange={(v) => {
                      const checked = Boolean(v);
                      if (isTeamArchive) {
                        archivedListRef.current?.toggleSelectAll(checked);
                      } else if (isTeamTrash) {
                        trashListRef.current?.toggleSelectAll(checked);
                      } else {
                        toggleSelectAll(checked);
                      }
                    }}
                    aria-label={tDash("selectAll")}
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {(isTeamSpecialView ? childSelectedCount : selectedIds.size) > 0
                      ? tl("selectedCount", { count: isTeamSpecialView ? childSelectedCount : selectedIds.size })
                      : tDash("selectAll")}
                  </span>
                  {(isTeamSpecialView ? childAtLimit : atLimit) && (
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
                  {tDash("close")}
                </Button>
              </div>
            ) : (
              <>
                {canDeletePerm && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSelectionMode(true); setActiveEntry(null); }}
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
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.LOGIN); setFormOpen(true); }}>
                          <KeyRound className="mr-2 h-4 w-4" />
                          {t("newPassword")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.SECURE_NOTE); setFormOpen(true); }}>
                          <FileText className="mr-2 h-4 w-4" />
                          {t("newSecureNote")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.CREDIT_CARD); setFormOpen(true); }}>
                          <CreditCard className="mr-2 h-4 w-4" />
                          {t("newCreditCard")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.IDENTITY); setFormOpen(true); }}>
                          <IdCard className="mr-2 h-4 w-4" />
                          {t("newIdentity")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.PASSKEY); setFormOpen(true); }}>
                          <Fingerprint className="mr-2 h-4 w-4" />
                          {t("newPasskey")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.BANK_ACCOUNT); setFormOpen(true); }}>
                          <Landmark className="mr-2 h-4 w-4" />
                          {t("newBankAccount")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.SOFTWARE_LICENSE); setFormOpen(true); }}>
                          <KeySquare className="mr-2 h-4 w-4" />
                          {t("newSoftwareLicense")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setEditEntryId(null); setNewEntryType(ENTRY_TYPE.SSH_KEY); setFormOpen(true); }}>
                          <Terminal className="mr-2 h-4 w-4" />
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

      {/* Main content area */}
      <div className={[
        "flex-1 min-h-0",
        isMasterDetail && (!isTeamSpecialView || isTeamArchive) ? "overflow-hidden" : "mx-auto max-w-4xl w-full",
      ].join(" ")}>
        {keyPending && !isTeamSpecialView && (
          <Card className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30 mb-4">
            <div className="flex items-start gap-3">
              <Clock className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-medium text-amber-800 dark:text-amber-300">
                  {t("keyPendingTitle")}
                </p>
                <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                  {t("keyPendingDesc")}
                </p>
              </div>
            </div>
          </Card>
        )}

        {isTeamArchive && team ? (
          <div className={isMasterDetail ? "h-full min-h-0" : "space-y-4"}>
            <TeamArchivedList
              ref={archivedListRef}
              teamId={teamId}
              teamName={team.name}
              role={team.role}
              searchQuery={searchQuery}
              refreshKey={refreshKey}
              sortBy={sortBy}
              selectionMode={selectionMode}
              onSelectedCountChange={(count, allSel, limit) => {
                setChildSelectedCount(count);
                setChildAllSelected(allSel);
                setChildAtLimit(limit);
              }}
            />
          </div>
        ) : isTeamTrash && team ? (
          <div className="space-y-4">
            <TeamTrashList
              ref={trashListRef}
              teamId={teamId}
              teamName={team.name}
              role={team.role}
              searchQuery={searchQuery}
              refreshKey={refreshKey}
              sortBy={sortBy}
              selectionMode={selectionMode}
              onSelectedCountChange={(count, allSel, limit) => {
                setChildSelectedCount(count);
                setChildAllSelected(allSel);
                setChildAtLimit(limit);
              }}
            />
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : sortedFiltered.length === 0 ? (
          <Card className="rounded-xl border bg-card/80 p-10">
            <div className="flex flex-col items-center justify-center text-center">
              <KeyRound className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-muted-foreground">
                {searchQuery ? tl("noMatch") : t("noPasswords")}
              </p>
              {!searchQuery && canCreate && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("noPasswordsDesc")}
                </p>
              )}
            </div>
          </Card>
        ) : layoutMode === "master-detail" ? (
          // 3-pane master-detail (lg+): compact rows on the left, detail pane on the right.
          <MasterDetailShell
            layoutMode={layoutMode}
            activeEntryId={activeEntry?.id ?? null}
            listSlot={
              <div className="space-y-1 p-2">
                <EntryListShell
                  entries={sortedFiltered}
                  selectionMode={selectionMode}
                  selectedIds={selectedIds}
                  atLimit={atLimit}
                  onToggleSelectOne={toggleSelectOne}
                  selectEntryLabel={(title) => tl("selectEntry", { title })}
                  floatingActions={floatingBulkActions}
                  confirmDialog={bulkConfirmDialog}
                  renderEntry={(entry) => (
                    <PasswordRow
                      entry={entry}
                      isActive={activeEntry?.id === entry.id}
                      onActivate={() =>
                        setActiveEntry((prev) =>
                          prev?.id === entry.id ? null : entry
                        )
                      }
                      selectionMode={selectionMode}
                      {...buildTeamRowCallbacks(entry)}
                      onShare={() => setActiveEntry(entry)}
                      onEdit={() => handleEdit(entry.id)}
                      onToggleArchive={() =>
                        void handleToggleArchive(entry.id, entry.isArchived)
                      }
                      onDeleteRequest={() => void handleDelete(entry.id)}
                      canEdit={canEditPerm}
                      canDelete={canDeletePerm}
                      canShare={canEditPerm}
                    />
                  )}
                />
              </div>
            }
            detailSlot={
              selectionMode ? (
                <div className="flex h-full items-center justify-center py-16 text-sm text-muted-foreground">
                  {tl("selectedCount", { count: selectedIds.size })}
                </div>
              ) : (
                <PasswordDetailPane
                  key={activeEntry?.id ?? "none"}
                  entryId={activeEntry?.id ?? null}
                  entry={activeEntry}
                  detailData={teamDetailData}
                  loading={teamDetailLoading}
                  error={teamDetailError}
                  onEdit={activeEntry ? () => handleEdit(activeEntry.id) : undefined}
                  onRefresh={() => {
                    fetchPasswords();
                    invalidateTeamDetail();
                  }}
                  teamId={teamId}
                  readOnly={!canEditPerm}
                />
              )
            }
          />
        ) : (
          // Accordion mode (< lg): existing PasswordCard list, unchanged behavior.
          <EntryListShell
            entries={sortedFiltered}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            atLimit={atLimit}
            onToggleSelectOne={toggleSelectOne}
            selectEntryLabel={(title) => tl("selectEntry", { title })}
            renderEntry={(entry) => (
              <PasswordCard
                entry={entry}
                expanded={expandedId === entry.id}
                onToggleFavorite={handleToggleFavorite}
                onToggleArchive={handleToggleArchive}
                onDelete={handleDelete}
                onToggleExpand={(id) =>
                  setExpandedId((prev) => (prev === id ? null : id))
                }
                onRefresh={() => {
                  fetchPasswords();
                  setExpandedId(null);
                }}
                getPassword={createPasswordFetcher(entry.id)}
                getDetail={createDetailFetcher(entry.id, entry.entryType)}
                getUrl={createUrlFetcher(entry.id)}
                onEditClick={() => handleEdit(entry.id)}
                canEdit={canEditPerm}
                canDelete={canDeletePerm}
                createdBy={
                  entry.createdBy.name
                    ? t("createdBy", { name: entry.createdBy.email ? `${entry.createdBy.name} (${entry.createdBy.email})` : entry.createdBy.name })
                    : undefined
                }
                teamId={teamId}
              />
            )}
            floatingActions={floatingBulkActions}
            confirmDialog={bulkConfirmDialog}
          />
        )}
      </div>

      {formOpen && !editEntryId && (
        <TeamNewDialog
          teamId={teamId}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={() => {
            handleSaved();
            setExpandedId(null);
            setRefreshKey((k) => k + 1);
          }}
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
          onSaved={() => {
            handleSaved();
            setExpandedId(null);
            setRefreshKey((k) => k + 1);
            invalidateTeamDetail();
          }}
          defaultFolderId={activeFolderId ?? null}
          defaultTags={matchedTag ? [{ id: matchedTag.id, name: matchedTag.name, color: matchedTag.color ?? null }] : undefined}
        />
      )}
    </div>
  );
}
