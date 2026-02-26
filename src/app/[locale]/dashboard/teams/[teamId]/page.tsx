"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { PasswordCard } from "@/components/passwords/password-card";
import { EntryListHeader } from "@/components/passwords/entry-list-header";
import { EntrySortMenu } from "@/components/passwords/entry-sort-menu";
import { SearchBar } from "@/components/layout/search-bar";
import type { InlineDetailData } from "@/components/passwords/password-detail-inline";
import { OrgPasswordForm as TeamPasswordForm } from "@/components/team/team-password-form";
import { OrgArchivedList as TeamArchivedList } from "@/components/team/team-archived-list";
import { OrgTrashList as TeamTrashList } from "@/components/team/team-trash-list";
import { OrgRoleBadge as TeamRoleBadge } from "@/components/team/team-role-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, KeyRound, FileText, CreditCard, IdCard, Fingerprint, Star, Archive, Trash2, Clock } from "lucide-react";
import { toast } from "sonner";
import { ORG_ROLE, ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { compareEntriesWithFavorite, type EntrySortOption } from "@/lib/entry-sort";
import { useOrgVault } from "@/lib/org-vault-context";
import { decryptData } from "@/lib/crypto-client";
import { buildOrgEntryAAD } from "@/lib/crypto-aad";

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
  isFavorite: boolean;
  isArchived: boolean;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { id: string; name: string | null; image: string | null };
  updatedBy: { id: string; name: string | null };
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
  const { getOrgEncryptionKey } = useOrgVault();
  const [org, setOrg] = useState<TeamInfo | null>(null);
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
  const [editData, setEditData] = useState<{
    id: string;
    entryType?: EntryTypeValue;
    title: string;
    username: string | null;
    password: string;
    content?: string;
    url: string | null;
    notes: string | null;
    tags?: { id: string; name: string; color: string | null }[];
    customFields?: EntryCustomField[];
    totp?: EntryTotp | null;
    cardholderName?: string | null;
    cardNumber?: string | null;
    brand?: string | null;
    expiryMonth?: string | null;
    expiryYear?: string | null;
    cvv?: string | null;
    fullName?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    dateOfBirth?: string | null;
    nationality?: string | null;
    idNumber?: string | null;
    issueDate?: string | null;
    expiryDate?: string | null;
    relyingPartyId?: string | null;
    relyingPartyName?: string | null;
    credentialId?: string | null;
    creationDate?: string | null;
    deviceInfo?: string | null;
    orgFolderId?: string | null;
  } | null>(null);
  const isTeamArchive = activeScope === "archive";
  const isTeamTrash = activeScope === "trash";
  const isTeamFavorites = activeScope === "favorites";
  const isTeamSpecialView = isTeamArchive || isTeamTrash;

  const fetchTeam = async (): Promise<boolean> => {
    try {
      const res = await fetch(apiPath.teamById(teamId));
      if (!res.ok) {
        setOrg(null);
        setLoadError(true);
        return false;
      }
      const data = await res.json();
      setOrg(data);
      setLoadError(false);
      return true;
    } catch {
      setOrg(null);
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
      const res = await fetch(url);
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const orgKey = await getOrgEncryptionKey(teamId);
      if (!orgKey) {
        setKeyPending(true);
        setPasswords([]);
        return;
      }
      setKeyPending(false);

      const decrypted = await Promise.all(
        data.map(async (entry: Record<string, unknown>) => {
          try {
            const aad = buildOrgEntryAAD(teamId, entry.id as string, "overview");
            const json = await decryptData(
              {
                ciphertext: entry.encryptedOverview as string,
                iv: entry.overviewIv as string,
                authTag: entry.overviewAuthTag as string,
              },
              orgKey,
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
  }, [teamId, activeTagId, activeFolderId, activeEntryType, isTeamFavorites, getOrgEncryptionKey]);

  useEffect(() => {
    setLoadError(false);
    (async () => {
      const ok = await fetchTeam();
      if (ok && !isTeamSpecialView) fetchPasswords();
      else setLoading(false);
    })();
  }, [teamId, fetchPasswords, isTeamSpecialView]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCreate =
    org?.role === ORG_ROLE.OWNER || org?.role === ORG_ROLE.ADMIN || org?.role === ORG_ROLE.MEMBER;
  const canDeletePerm = org?.role === ORG_ROLE.OWNER || org?.role === ORG_ROLE.ADMIN;
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
      } as Record<string, string>)[activeEntryType] ?? activeEntryType
    : null;
  const subtitle = isTeamTrash
    ? t("trash")
    : isTeamArchive
      ? t("archive")
      : isTeamFavorites
        ? t("favorites")
      : (activeCategoryLabel ?? t("passwords"));
  const ENTRY_TYPE_ICONS: Record<string, React.ReactNode> = {
    LOGIN: <KeyRound className="h-6 w-6" />,
    SECURE_NOTE: <FileText className="h-6 w-6" />,
    CREDIT_CARD: <CreditCard className="h-6 w-6" />,
    IDENTITY: <IdCard className="h-6 w-6" />,
    PASSKEY: <Fingerprint className="h-6 w-6" />,
  };

  const headerIcon = isTeamTrash
    ? <Trash2 className="h-6 w-6" />
    : isTeamArchive
      ? <Archive className="h-6 w-6" />
      : isTeamFavorites
        ? <Star className="h-6 w-6" />
        : activeEntryType && ENTRY_TYPE_ICONS[activeEntryType]
          ? ENTRY_TYPE_ICONS[activeEntryType]
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
    // Optimistic update
    if (isTeamFavorites && current) {
      setPasswords((prev) => prev.filter((e) => e.id !== id));
    } else {
      setPasswords((prev) =>
        prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
      );
    }
    try {
      const res = await fetch(apiPath.teamPasswordFavorite(teamId, id), {
        method: "POST",
      });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
  };

  const handleToggleArchive = async (id: string, current: boolean) => {
    setPasswords((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.teamPasswordById(teamId, id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: !current }),
      });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
  };

  const handleDelete = async (id: string) => {
    setPasswords((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.teamPasswordById(teamId, id), {
        method: "DELETE",
      });
      if (!res.ok) fetchPasswords();
    } catch {
      toast.error(t("networkError"));
      fetchPasswords();
    }
  };

  const decryptFullBlob = useCallback(
    async (id: string, raw: Record<string, unknown>) => {
      const orgKey = await getOrgEncryptionKey(teamId);
      if (!orgKey) throw new Error("No org key");
      const aad = buildOrgEntryAAD(teamId, id, "blob");
      const json = await decryptData(
        {
          ciphertext: raw.encryptedBlob as string,
          iv: raw.blobIv as string,
          authTag: raw.blobAuthTag as string,
        },
        orgKey,
        aad,
      );
      return JSON.parse(json) as Record<string, unknown>;
    },
    [teamId, getOrgEncryptionKey],
  );

  const handleEdit = async (id: string) => {
    try {
      const res = await fetch(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) throw new Error("Failed");
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      setEditData({
        id: raw.id,
        entryType: raw.entryType,
        title: (blob.title as string) ?? "",
        username: (blob.username as string) ?? null,
        password: (blob.password as string) ?? "",
        content: blob.content as string | undefined,
        url: (blob.url as string) ?? null,
        notes: (blob.notes as string) ?? null,
        tags: raw.tags,
        customFields: blob.customFields as EntryCustomField[] | undefined,
        totp: blob.totp as EntryTotp | null | undefined,
        cardholderName: blob.cardholderName as string | null | undefined,
        cardNumber: blob.cardNumber as string | null | undefined,
        brand: blob.brand as string | null | undefined,
        expiryMonth: blob.expiryMonth as string | null | undefined,
        expiryYear: blob.expiryYear as string | null | undefined,
        cvv: blob.cvv as string | null | undefined,
        fullName: blob.fullName as string | null | undefined,
        address: blob.address as string | null | undefined,
        phone: blob.phone as string | null | undefined,
        email: blob.email as string | null | undefined,
        dateOfBirth: blob.dateOfBirth as string | null | undefined,
        nationality: blob.nationality as string | null | undefined,
        idNumber: blob.idNumber as string | null | undefined,
        issueDate: blob.issueDate as string | null | undefined,
        expiryDate: blob.expiryDate as string | null | undefined,
        relyingPartyId: blob.relyingPartyId as string | null | undefined,
        relyingPartyName: blob.relyingPartyName as string | null | undefined,
        credentialId: blob.credentialId as string | null | undefined,
        creationDate: blob.creationDate as string | null | undefined,
        deviceInfo: blob.deviceInfo as string | null | undefined,
        orgFolderId: (raw.orgFolderId as string) ?? null,
      });
      setFormOpen(true);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const createDetailFetcher = useCallback(
    (id: string, eType?: EntryTypeValue) => async (): Promise<InlineDetailData> => {
      const res = await fetch(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) throw new Error("Failed");
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      return {
        id: raw.id,
        entryType: eType,
        password: (blob.password as string) ?? "",
        content: blob.content as string | undefined,
        url: (blob.url as string) ?? null,
        urlHost: null,
        notes: (blob.notes as string) ?? null,
        customFields: (blob.customFields as EntryCustomField[]) ?? [],
        passwordHistory: [],
        totp: blob.totp as EntryTotp | undefined,
        cardholderName: blob.cardholderName as string | undefined,
        cardNumber: blob.cardNumber as string | undefined,
        brand: blob.brand as string | undefined,
        expiryMonth: blob.expiryMonth as string | undefined,
        expiryYear: blob.expiryYear as string | undefined,
        cvv: blob.cvv as string | undefined,
        fullName: blob.fullName as string | undefined,
        address: blob.address as string | undefined,
        phone: blob.phone as string | undefined,
        email: blob.email as string | undefined,
        dateOfBirth: blob.dateOfBirth as string | undefined,
        nationality: blob.nationality as string | undefined,
        idNumber: blob.idNumber as string | undefined,
        issueDate: blob.issueDate as string | undefined,
        expiryDate: blob.expiryDate as string | undefined,
        relyingPartyId: blob.relyingPartyId as string | undefined,
        relyingPartyName: blob.relyingPartyName as string | undefined,
        username: blob.username as string | undefined,
        credentialId: blob.credentialId as string | undefined,
        creationDate: blob.creationDate as string | undefined,
        deviceInfo: blob.deviceInfo as string | undefined,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      };
    },
    [teamId, decryptFullBlob],
  );

  const createPasswordFetcher = useCallback(
    (id: string) => async (): Promise<string> => {
      const res = await fetch(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) throw new Error("Failed");
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      return (blob.password as string) ?? (blob.content as string) ?? "";
    },
    [teamId, decryptFullBlob],
  );

  const createUrlFetcher = useCallback(
    (id: string) => async (): Promise<string | null> => {
      const res = await fetch(apiPath.teamPasswordById(teamId, id));
      if (!res.ok) throw new Error("Failed");
      const raw = await res.json();
      const blob = await decryptFullBlob(id, raw);
      return (blob.url as string) ?? null;
    },
    [teamId, decryptFullBlob],
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
      p.relyingPartyId?.toLowerCase().includes(q)
    );
  });
  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesWithFavorite(a, b, sortBy)
  );

  if (loadError) {
    return (
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-4xl">
          <Card className="rounded-xl border bg-card/80 p-6">
            <div className="flex flex-col items-start gap-3">
            <h1 className="text-xl font-semibold">{t("forbidden")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("noOrgsDesc")}
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

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <EntryListHeader
          icon={headerIcon}
          title={isPrimaryScopeLabel ? subtitle : (org?.name ?? "...")}
          subtitle={subtitle}
          showSubtitle={!isPrimaryScopeLabel}
          titleExtra={!isPrimaryScopeLabel && org ? <TeamRoleBadge role={org.role} /> : null}
          actions={
            <>
              {canCreate && !isTeamSpecialView && (
                contextualEntryType ? (
                  <Button
                    onClick={() => {
                      setEditData(null);
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
                      <DropdownMenuItem onClick={() => { setEditData(null); setNewEntryType(ENTRY_TYPE.LOGIN); setFormOpen(true); }}>
                        <KeyRound className="mr-2 h-4 w-4" />
                        {t("newPassword")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setEditData(null); setNewEntryType(ENTRY_TYPE.SECURE_NOTE); setFormOpen(true); }}>
                        <FileText className="mr-2 h-4 w-4" />
                        {t("newSecureNote")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setEditData(null); setNewEntryType(ENTRY_TYPE.CREDIT_CARD); setFormOpen(true); }}>
                        <CreditCard className="mr-2 h-4 w-4" />
                        {t("newCreditCard")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setEditData(null); setNewEntryType(ENTRY_TYPE.IDENTITY); setFormOpen(true); }}>
                        <IdCard className="mr-2 h-4 w-4" />
                        {t("newIdentity")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setEditData(null); setNewEntryType(ENTRY_TYPE.PASSKEY); setFormOpen(true); }}>
                        <Fingerprint className="mr-2 h-4 w-4" />
                        {t("newPasskey")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )
              )}
            </>
          }
        />

        <div className="flex items-center gap-2 rounded-xl border bg-card/80 p-3">
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

        {keyPending && !isTeamSpecialView && (
          <Card className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
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

        {isTeamArchive ? (
          <TeamArchivedList
            teamId={teamId}
            searchQuery={searchQuery}
            refreshKey={refreshKey}
            sortBy={sortBy}
          />
        ) : isTeamTrash ? (
          <TeamTrashList
            teamId={teamId}
            searchQuery={searchQuery}
            refreshKey={refreshKey}
            sortBy={sortBy}
          />
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : sortedFiltered.length === 0 ? (
          <Card className="rounded-xl border bg-card/80 p-10">
            <div className="flex flex-col items-center justify-center text-center">
              <KeyRound className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-muted-foreground">{t("noPasswords")}</p>
              {!searchQuery && canCreate && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("noPasswordsDesc")}
                </p>
              )}
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {sortedFiltered.map((entry) => (
              <PasswordCard
                key={entry.id}
                id={entry.id}
                entryType={entry.entryType}
                title={entry.title}
                username={entry.username}
                urlHost={entry.urlHost}
                snippet={entry.snippet}
                brand={entry.brand}
                lastFour={entry.lastFour}
                cardholderName={entry.cardholderName}
                fullName={entry.fullName}
                idNumberLast4={entry.idNumberLast4}
                relyingPartyId={entry.relyingPartyId}
                tags={entry.tags}
                isFavorite={entry.isFavorite}
                isArchived={entry.isArchived}
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
                    ? t("createdBy", { name: entry.createdBy.name })
                    : undefined
                }
                teamId={teamId}
              />
            ))}
          </div>
        )}
      </div>

      <TeamPasswordForm
        orgId={teamId}
        teamId={teamId}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={() => {
          fetchPasswords();
          setExpandedId(null);
          setRefreshKey((k) => k + 1);
        }}
        editData={editData}
        entryType={editData?.entryType ?? newEntryType}
      />
    </div>
  );
}
