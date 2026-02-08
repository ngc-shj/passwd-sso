"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { PasswordCard } from "@/components/passwords/password-card";
import type { InlineDetailData } from "@/components/passwords/password-detail-inline";
import { OrgPasswordForm } from "@/components/org/org-password-form";
import { OrgRoleBadge } from "@/components/org/org-role-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Settings, KeyRound, Search } from "lucide-react";
import { toast } from "sonner";

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

export default function OrgDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const t = useTranslations("Org");
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [passwords, setPasswords] = useState<OrgPasswordEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  const fetchOrg = () => {
    fetch(`/api/orgs/${orgId}`)
      .then((res) => res.json())
      .then(setOrg)
      .catch(() => {});
  };

  const fetchPasswords = useCallback(() => {
    setLoading(true);
    fetch(`/api/orgs/${orgId}/passwords`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setPasswords(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId]);

  useEffect(() => {
    fetchOrg();
    fetchPasswords();
  }, [orgId, fetchPasswords]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCreate =
    org?.role === "OWNER" || org?.role === "ADMIN" || org?.role === "MEMBER";
  const canDeletePerm = org?.role === "OWNER" || org?.role === "ADMIN";
  const canEditPerm = canCreate;

  const handleToggleFavorite = async (id: string, current: boolean) => {
    // Optimistic update
    setPasswords((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
    );
    try {
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}/favorite`, {
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
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`, {
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
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`, {
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
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setEditData(data);
      setFormOpen(true);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const createDetailFetcher = useCallback(
    (id: string) => async (): Promise<InlineDetailData> => {
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`);
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
    [orgId]
  );

  const createPasswordFetcher = useCallback(
    (id: string) => async (): Promise<string> => {
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return data.password;
    },
    [orgId]
  );

  const createUrlFetcher = useCallback(
    (id: string) => async (): Promise<string | null> => {
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`);
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
      p.urlHost?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold truncate">{org?.name ?? "..."}</h1>
            {org && <OrgRoleBadge role={org.role} />}
          </div>
          <div className="flex items-center gap-2">
            {(org?.role === "OWNER" || org?.role === "ADMIN") && (
              <Button variant="ghost" size="icon" asChild>
                <Link href={`/dashboard/orgs/${orgId}/settings`}>
                  <Settings className="h-4 w-4" />
                </Link>
              </Button>
            )}
            {canCreate && (
              <Button
                size="sm"
                onClick={() => {
                  setEditData(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-2" />
                {t("newPassword")}
              </Button>
            )}
          </div>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("allPasswords")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <KeyRound className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">{t("noPasswords")}</p>
            {!searchQuery && canCreate && (
              <p className="text-sm text-muted-foreground mt-1">
                {t("noPasswordsDesc")}
              </p>
            )}
          </div>
        ) : (
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
                  fetchPasswords();
                  setExpandedId(null);
                }}
                getPassword={createPasswordFetcher(entry.id)}
                getDetail={createDetailFetcher(entry.id)}
                getUrl={createUrlFetcher(entry.id)}
                onEditClick={() => handleEdit(entry.id)}
                canEdit={canEditPerm}
                canDelete={canDeletePerm}
                createdBy={
                  entry.createdBy.name
                    ? t("createdBy", { name: entry.createdBy.name })
                    : undefined
                }
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
        }}
        editData={editData}
      />
    </div>
  );
}
