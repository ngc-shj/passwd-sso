"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OrgCreateDialog as TeamCreateDialog } from "@/components/team/team-create-dialog";
import { OrgRoleBadge as TeamRoleBadge } from "@/components/team/team-role-badge";
import { Plus, Building2, Users, KeyRound } from "lucide-react";
import { API_PATH } from "@/lib/constants";

interface TeamListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  createdAt: string;
}

export default function TeamsPage() {
  const t = useTranslations("Team");
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTeams = () => {
    setLoading(true);
    fetch(API_PATH.TEAMS)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setTeams(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleCreated = () => {
    fetchTeams();
    window.dispatchEvent(new CustomEvent("org-data-changed"));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTeams();
  }, []);

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-3">
                <Building2 className="h-6 w-6" />
                <h1 className="text-2xl font-bold">{t("organizations")}</h1>
              </div>
              <p className="text-sm text-muted-foreground">{t("manage")}</p>
            </div>
            <TeamCreateDialog
              trigger={
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  {t("createOrg")}
                </Button>
              }
              onCreated={handleCreated}
            />
          </div>
        </Card>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
            <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">{t("noOrgs")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("noOrgsDesc")}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((team) => (
              <Link
                key={team.id}
                href={`/dashboard/teams/${team.id}`}
                className="group block rounded-xl border bg-card/80 p-4 transition-colors hover:bg-accent"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="truncate font-semibold">{team.name}</h3>
                  <TeamRoleBadge role={team.role} />
                </div>
                {team.description && (
                  <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                    {team.description}
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
