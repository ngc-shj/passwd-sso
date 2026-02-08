"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { OrgCreateDialog } from "@/components/org/org-create-dialog";
import { OrgRoleBadge } from "@/components/org/org-role-badge";
import { Plus, Building2, Users, KeyRound } from "lucide-react";

interface OrgListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  createdAt: string;
}

export default function OrgsPage() {
  const t = useTranslations("Org");
  const [orgs, setOrgs] = useState<OrgListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOrgs = () => {
    setLoading(true);
    fetch("/api/orgs")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setOrgs(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleCreated = () => {
    fetchOrgs();
    window.dispatchEvent(new CustomEvent("org-data-changed"));
  };

  useEffect(() => {
    fetchOrgs();
  }, []);

  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold">{t("organizations")}</h1>
          <OrgCreateDialog
            trigger={
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                {t("createOrg")}
              </Button>
            }
            onCreated={handleCreated}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : orgs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">{t("noOrgs")}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("noOrgsDesc")}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {orgs.map((org) => (
              <Link
                key={org.id}
                href={`/dashboard/orgs/${org.id}`}
                className="group block rounded-lg border p-4 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold truncate">{org.name}</h3>
                  <OrgRoleBadge role={org.role} />
                </div>
                {org.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                    {org.description}
                  </p>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" />
                  </span>
                  <span className="flex items-center gap-1">
                    <KeyRound className="h-3 w-3" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
