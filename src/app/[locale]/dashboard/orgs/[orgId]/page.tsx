"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { PasswordCard } from "@/components/passwords/password-card";
import type { InlineDetailData } from "@/components/passwords/password-detail-inline";
import { OrgPasswordForm } from "@/components/org/org-password-form";
import { OrgArchivedList } from "@/components/org/org-archived-list";
import { OrgTrashList } from "@/components/org/org-trash-list";
import { OrgRoleBadge } from "@/components/org/org-role-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OrgExportDialog } from "@/components/org/org-export-dialog";
import { Plus, Settings, KeyRound, Search, FileText, CreditCard, IdCard, Fingerprint, Download } from "lucide-react";
import { toast } from "sonner";
import { ORG_ROLE, ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue, TotpAlgorithm, CustomFieldType } from "@/lib/constants";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  passwordCount: number;
}

interface OrgPasswordEntry {
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

export default function OrgDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const searchParams = useSearchParams();
  const activeTagId = searchParams.get("tag");
  const activeFolderId = searchParams.get("folder");
  const activeEntryType = searchParams.get("type");
  const activeScope = searchParams.get("scope");
  const t = useTranslations("Org");
  const tDash = useTranslations("Dashboard");
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [passwords, setPasswords] = useState<OrgPasswordEntry[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
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
    customFields?: { label: string; value: string; type: CustomFieldType }[];
    totp?: { secret: string; algorithm?: TotpAlgorithm; digits?: number; period?: number } | null;
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
  } | null>(null);
  const isOrgArchive = activeScope === "archive";
  const isOrgTrash = activeScope === "trash";
  const isOrgSpecialView = isOrgArchive || isOrgTrash;

  const fetchOrg = async (): Promise<boolean> => {
    try {
      const res = await fetch(apiPath.orgById(orgId));
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

  const fetchPasswords = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (activeTagId) params.set("tag", activeTagId);
    if (activeFolderId) params.set("folder", activeFolderId);
    if (activeEntryType) params.set("type", activeEntryType);
    const qs = params.toString();
    const url = `${apiPath.orgPasswords(orgId)}${qs ? `?${qs}` : ""}`;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setPasswords(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId, activeTagId, activeFolderId, activeEntryType]);

  useEffect(() => {
    setLoadError(false);
    (async () => {
      const ok = await fetchOrg();
      if (ok && !isOrgSpecialView) fetchPasswords();
      else setLoading(false);
    })();
  }, [orgId, fetchPasswords, isOrgSpecialView]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const subtitle = isOrgTrash
    ? t("organizationTrash")
    : isOrgArchive
      ? t("organizationArchive")
      : (activeCategoryLabel ?? t("allPasswords"));

  const handleToggleFavorite = async (id: string, current: boolean) => {
    // Optimistic update
    setPasswords((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
    );
    try {
      const res = await fetch(apiPath.orgPasswordFavorite(orgId, id), {
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
      const res = await fetch(apiPath.orgPasswordById(orgId, id), {
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
      const res = await fetch(apiPath.orgPasswordById(orgId, id), {
        method: "DELETE",
      });
      if (!res.ok) fetchPasswords();
    } catch {
      toast.error(t("networkError"));
      fetchPasswords();
    }
  };

  const handleEdit = async (id: string) => {
    try {
      const res = await fetch(apiPath.orgPasswordById(orgId, id));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setEditData(data);
      setFormOpen(true);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const createDetailFetcher = useCallback(
    (id: string, eType?: EntryTypeValue) => async (): Promise<InlineDetailData> => {
      const res = await fetch(apiPath.orgPasswordById(orgId, id));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return {
        id: data.id,
        entryType: eType,
        password: data.password ?? "",
        content: data.content,
        url: data.url ?? null,
        urlHost: null,
        notes: data.notes ?? null,
        customFields: data.customFields ?? [],
        passwordHistory: [],
        totp: data.totp ?? undefined,
        cardholderName: data.cardholderName ?? undefined,
        cardNumber: data.cardNumber ?? undefined,
        brand: data.brand ?? undefined,
        expiryMonth: data.expiryMonth ?? undefined,
        expiryYear: data.expiryYear ?? undefined,
        cvv: data.cvv ?? undefined,
        fullName: data.fullName ?? undefined,
        address: data.address ?? undefined,
        phone: data.phone ?? undefined,
        email: data.email ?? undefined,
        dateOfBirth: data.dateOfBirth ?? undefined,
        nationality: data.nationality ?? undefined,
        idNumber: data.idNumber ?? undefined,
        issueDate: data.issueDate ?? undefined,
        expiryDate: data.expiryDate ?? undefined,
        relyingPartyId: data.relyingPartyId ?? undefined,
        relyingPartyName: data.relyingPartyName ?? undefined,
        username: data.username ?? undefined,
        credentialId: data.credentialId ?? undefined,
        creationDate: data.creationDate ?? undefined,
        deviceInfo: data.deviceInfo ?? undefined,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    },
    [orgId]
  );

  const createPasswordFetcher = useCallback(
    (id: string) => async (): Promise<string> => {
      const res = await fetch(apiPath.orgPasswordById(orgId, id));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return data.password ?? data.content ?? "";
    },
    [orgId]
  );

  const createUrlFetcher = useCallback(
    (id: string) => async (): Promise<string | null> => {
      const res = await fetch(apiPath.orgPasswordById(orgId, id));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return data.url;
    },
    [orgId]
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
      p.lastFour?.includes(q) ||
      p.cardholderName?.toLowerCase().includes(q) ||
      p.fullName?.toLowerCase().includes(q) ||
      p.idNumberLast4?.includes(q) ||
      p.relyingPartyId?.toLowerCase().includes(q)
    );
  });

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
              <Link href="/dashboard/orgs">
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
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="truncate text-2xl font-bold">
                  {org?.name ?? "..."}
                </h1>
                {org && <OrgRoleBadge role={org.role} />}
              </div>
              <p className="text-sm text-muted-foreground">
                {subtitle}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {(org?.role === ORG_ROLE.OWNER || org?.role === ORG_ROLE.ADMIN) && (
                <OrgExportDialog
                  orgId={orgId}
                  trigger={
                    <Button variant="ghost" size="icon">
                      <Download className="h-4 w-4" />
                    </Button>
                  }
                />
              )}
              {(org?.role === ORG_ROLE.OWNER || org?.role === ORG_ROLE.ADMIN) && (
                <Button variant="ghost" size="icon" asChild>
                  <Link href={`/dashboard/orgs/${orgId}/settings`}>
                    <Settings className="h-4 w-4" />
                  </Link>
                </Button>
              )}
              {canCreate && !isOrgSpecialView && (
                contextualEntryType ? (
                  <Button
                    size="sm"
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
                      <Button size="sm">
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
            </div>
          </div>
        </Card>

        <Card className="rounded-xl border bg-card/80 p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={subtitle}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </Card>

        {isOrgArchive ? (
          <OrgArchivedList
            orgId={orgId}
            searchQuery={searchQuery}
            refreshKey={refreshKey}
          />
        ) : isOrgTrash ? (
          <OrgTrashList
            orgId={orgId}
            searchQuery={searchQuery}
            refreshKey={refreshKey}
          />
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
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
            {filtered.map((entry) => (
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
                orgId={orgId}
              />
            ))}
          </div>
        )}
      </div>

      <OrgPasswordForm
        orgId={orgId}
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
