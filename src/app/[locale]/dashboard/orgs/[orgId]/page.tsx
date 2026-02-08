"use client";

import { useEffect, useState, use } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { OrgPasswordCard } from "@/components/org/org-password-card";
import { OrgPasswordForm } from "@/components/org/org-password-form";
import { OrgPasswordDetail } from "@/components/org/org-password-detail";
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editData, setEditData] = useState<{
    id: string;
    title: string;
    username: string | null;
    password: string;
    url: string | null;
    notes: string | null;
  } | null>(null);

  const fetchOrg = () => {
    fetch(`/api/orgs/${orgId}`)
      .then((res) => res.json())
      .then(setOrg)
      .catch(() => {});
  };

  const fetchPasswords = () => {
    setLoading(true);
    fetch(`/api/orgs/${orgId}/passwords`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setPasswords(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchOrg();
    fetchPasswords();
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCreate =
    org?.role === "OWNER" || org?.role === "ADMIN" || org?.role === "MEMBER";
  const canDelete = org?.role === "OWNER" || org?.role === "ADMIN";
  const canEdit = canCreate;

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/passwords/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed");
      fetchPasswords();
    } catch {
      toast.error(t("networkError"));
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
              <OrgPasswordCard
                key={entry.id}
                entry={entry}
                orgId={orgId}
                canEdit={canEdit}
                canDelete={canDelete}
                onClick={() => setDetailId(entry.id)}
                onEdit={() => handleEdit(entry.id)}
                onDelete={() => handleDelete(entry.id)}
              />
            ))}
          </div>
        )}
      </div>

      <OrgPasswordForm
        orgId={orgId}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={fetchPasswords}
        editData={editData}
      />

      <OrgPasswordDetail
        orgId={orgId}
        passwordId={detailId}
        open={!!detailId}
        onOpenChange={(v) => {
          if (!v) setDetailId(null);
        }}
      />
    </div>
  );
}
