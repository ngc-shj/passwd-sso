"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { PasswordCard } from "@/components/passwords/password-card";
import type { InlineDetailData } from "@/components/passwords/password-detail-inline";
import { OrgPasswordForm } from "@/components/org/org-password-form";
import { Building2 } from "lucide-react";

interface OrgArchivedEntry {
  id: string;
  orgId: string;
  orgName: string;
  role: string;
  title: string;
  username: string | null;
  urlHost: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { id: string; name: string | null; image: string | null };
  updatedBy: { id: string; name: string | null };
  createdAt: string;
  updatedAt: string;
}

interface OrgArchivedListProps {
  searchQuery: string;
  refreshKey: number;
}

export function OrgArchivedList({ searchQuery, refreshKey }: OrgArchivedListProps) {
  const t = useTranslations("Org");
  const [entries, setEntries] = useState<OrgArchivedEntry[]>([]);
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
    customFields?: { label: string; value: string; type: "text" | "hidden" | "url" }[];
    totp?: { secret: string; algorithm?: "SHA1" | "SHA256" | "SHA512"; digits?: number; period?: number } | null;
  } | null>(null);

  const fetchArchived = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/orgs/archived");
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
    fetchArchived();
  }, [fetchArchived, refreshKey]);

  const handleToggleFavorite = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !e.isFavorite } : e))
    );
    try {
      await fetch(`/api/orgs/${entry.orgId}/passwords/${id}/favorite`, {
        method: "POST",
      });
    } catch {
      fetchArchived();
    }
  };

  const handleToggleArchive = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    // Unarchive: remove from this list
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(`/api/orgs/${entry.orgId}/passwords/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: false }),
      });
      if (!res.ok) fetchArchived();
    } catch {
      fetchArchived();
    }
  };

  const handleDelete = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(`/api/orgs/${entry.orgId}/passwords/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) fetchArchived();
    } catch {
      fetchArchived();
    }
  };

  const handleEdit = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    try {
      const res = await fetch(`/api/orgs/${entry.orgId}/passwords/${id}`);
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
    (entry: OrgArchivedEntry) =>
      async (): Promise<InlineDetailData> => {
        const res = await fetch(`/api/orgs/${entry.orgId}/passwords/${entry.id}`);
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        return {
          id: data.id,
          password: data.password,
          url: data.url,
          urlHost: null,
          notes: data.notes,
          customFields: data.customFields ?? [],
          passwordHistory: [],
          totp: data.totp ?? undefined,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
      },
    []
  );

  const createPasswordFetcher = useCallback(
    (entry: OrgArchivedEntry) =>
      async (): Promise<string> => {
        const res = await fetch(`/api/orgs/${entry.orgId}/passwords/${entry.id}`);
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        return data.password;
      },
    []
  );

  const createUrlFetcher = useCallback(
    (entry: OrgArchivedEntry) =>
      async (): Promise<string | null> => {
        const res = await fetch(`/api/orgs/${entry.orgId}/passwords/${entry.id}`);
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        return data.url;
      },
    []
  );

  const filtered = entries.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.title.toLowerCase().includes(q) ||
      p.username?.toLowerCase().includes(q) ||
      p.urlHost?.toLowerCase().includes(q) ||
      p.orgName.toLowerCase().includes(q)
    );
  });

  if (loading || filtered.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("organizationArchive")}
        </h2>
      </div>
      <div className="space-y-2">
        {filtered.map((entry) => (
          <PasswordCard
            key={entry.id}
            id={entry.id}
            title={entry.title}
            username={entry.username}
            urlHost={entry.urlHost}
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
              fetchArchived();
              setExpandedId(null);
            }}
            getPassword={createPasswordFetcher(entry)}
            getDetail={createDetailFetcher(entry)}
            getUrl={createUrlFetcher(entry)}
            onEditClick={() => handleEdit(entry.id)}
            canEdit={entry.role === "OWNER" || entry.role === "ADMIN" || entry.role === "MEMBER"}
            canDelete={entry.role === "OWNER" || entry.role === "ADMIN"}
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
            fetchArchived();
            setExpandedId(null);
          }}
          editData={editData}
        />
      )}
    </div>
  );
}
