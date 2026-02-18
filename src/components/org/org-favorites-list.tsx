"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { PasswordCard } from "@/components/passwords/password-card";
import type { InlineDetailData } from "@/components/passwords/password-detail-inline";
import { OrgPasswordForm } from "@/components/org/org-password-form";
import { Building2 } from "lucide-react";
import { ORG_ROLE, API_PATH, apiPath } from "@/lib/constants";
import type { EntryTypeValue, TotpAlgorithm, CustomFieldType } from "@/lib/constants";

interface OrgFavoriteEntry {
  id: string;
  entryType: EntryTypeValue;
  orgId: string;
  orgName: string;
  role: string;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { id: string; name: string | null; image: string | null };
  updatedBy: { id: string; name: string | null };
  createdAt: string;
  updatedAt: string;
}

interface OrgFavoritesListProps {
  searchQuery: string;
  refreshKey: number;
}

export function OrgFavoritesList({ searchQuery, refreshKey }: OrgFavoritesListProps) {
  const t = useTranslations("Org");
  const [entries, setEntries] = useState<OrgFavoriteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editOrgId, setEditOrgId] = useState<string | null>(null);
  const [editData, setEditData] = useState<{
    id: string;
    title: string;
    username: string | null;
    password: string;
    url: string | null;
    notes: string | null;
    tags?: { id: string; name: string; color: string | null }[];
    customFields?: { label: string; value: string; type: CustomFieldType }[];
    totp?: { secret: string; algorithm?: TotpAlgorithm; digits?: number; period?: number } | null;
  } | null>(null);

  const fetchFavorites = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API_PATH.ORGS_FAVORITES);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setEntries(data);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFavorites();
  }, [fetchFavorites, refreshKey]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleToggleFavorite = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    // Optimistic: remove from list
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await fetch(apiPath.orgPasswordFavorite(entry.orgId, id), {
        method: "POST",
      });
    } catch {
      fetchFavorites();
    }
  };

  const handleToggleArchive = async (id: string, current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.orgPasswordById(entry.orgId, id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: !current }),
      });
      if (!res.ok) fetchFavorites();
    } catch {
      fetchFavorites();
    }
  };

  const handleDelete = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.orgPasswordById(entry.orgId, id), {
        method: "DELETE",
      });
      if (!res.ok) fetchFavorites();
    } catch {
      fetchFavorites();
    }
  };

  const handleEdit = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    try {
      const res = await fetch(apiPath.orgPasswordById(entry.orgId, id));
      if (!res.ok) return;
      const data = await res.json();
      setEditOrgId(entry.orgId);
      setEditData(data);
      setFormOpen(true);
    } catch {
      // ignore
    }
  };

  const createDetailFetcher = useCallback(
    (entry: OrgFavoriteEntry) =>
      async (): Promise<InlineDetailData> => {
        const res = await fetch(
          apiPath.orgPasswordById(entry.orgId, entry.id)
        );
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        return {
          id: data.id,
          entryType: entry.entryType,
          password: data.password ?? "",
          content: data.content,
          url: data.url ?? null,
          urlHost: null,
          notes: data.notes ?? null,
          customFields: data.customFields ?? [],
          passwordHistory: [],
          totp: data.totp ?? undefined,
          brand: data.brand ?? null,
          cardholderName: data.cardholderName ?? null,
          cardNumber: data.cardNumber ?? null,
          expiryMonth: data.expiryMonth ?? null,
          expiryYear: data.expiryYear ?? null,
          cvv: data.cvv ?? null,
          fullName: data.fullName ?? null,
          address: data.address ?? null,
          phone: data.phone ?? null,
          email: data.email ?? null,
          dateOfBirth: data.dateOfBirth ?? null,
          nationality: data.nationality ?? null,
          idNumber: data.idNumber ?? null,
          issueDate: data.issueDate ?? null,
          expiryDate: data.expiryDate ?? null,
          relyingPartyId: data.relyingPartyId ?? null,
          relyingPartyName: data.relyingPartyName ?? null,
          username: data.username ?? null,
          credentialId: data.credentialId ?? null,
          creationDate: data.creationDate ?? null,
          deviceInfo: data.deviceInfo ?? null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
      },
    []
  );

  const createPasswordFetcher = useCallback(
    (entry: OrgFavoriteEntry) =>
      async (): Promise<string> => {
        const res = await fetch(
          apiPath.orgPasswordById(entry.orgId, entry.id)
        );
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        return data.password ?? data.content ?? "";
      },
    []
  );

  const createUrlFetcher = useCallback(
    (entry: OrgFavoriteEntry) =>
      async (): Promise<string | null> => {
        const res = await fetch(
          apiPath.orgPasswordById(entry.orgId, entry.id)
        );
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        return data.url;
      },
    []
  );

  // Client-side search filter
  const filtered = entries.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.title.toLowerCase().includes(q) ||
      p.username?.toLowerCase().includes(q) ||
      p.urlHost?.toLowerCase().includes(q) ||
      p.snippet?.toLowerCase().includes(q) ||
      p.fullName?.toLowerCase().includes(q) ||
      p.idNumberLast4?.includes(q) ||
      p.brand?.toLowerCase().includes(q) ||
      p.lastFour?.includes(q) ||
      p.cardholderName?.toLowerCase().includes(q) ||
      p.orgName.toLowerCase().includes(q)
    );
  });

  if (loading || filtered.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("favorites")}
        </h2>
      </div>
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
              fetchFavorites();
              setExpandedId(null);
            }}
            getPassword={createPasswordFetcher(entry)}
            getDetail={createDetailFetcher(entry)}
            getUrl={createUrlFetcher(entry)}
            onEditClick={() => handleEdit(entry.id)}
            canEdit={entry.role === ORG_ROLE.OWNER || entry.role === ORG_ROLE.ADMIN || entry.role === ORG_ROLE.MEMBER}
            canDelete={entry.role === ORG_ROLE.OWNER || entry.role === ORG_ROLE.ADMIN}
            createdBy={entry.orgName}
          />
        ))}
      </div>

      {editOrgId && (
        <OrgPasswordForm
          orgId={editOrgId}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={() => {
            fetchFavorites();
            setExpandedId(null);
          }}
          editData={editData}
        />
      )}
    </div>
  );
}
