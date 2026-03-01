"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TeamCreateDialog } from "@/components/team/team-create-dialog";
import { TeamRoleBadge } from "@/components/team/team-role-badge";
import { Plus, Building2, CalendarClock, Globe } from "lucide-react";
import { API_PATH } from "@/lib/constants";
import { formatDate } from "@/lib/format-datetime";

interface TeamListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  createdAt: string;
  memberCount: number;
  tenantName?: string;
  isCrossTenant?: boolean;
}

export default function TeamsPage() {
  const t = useTranslations("Team");
  const locale = useLocale();
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
    window.dispatchEvent(new CustomEvent("team-data-changed"));
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
                <h1 className="text-2xl font-bold">{t("teams")}</h1>
              </div>
              <p className="text-sm text-muted-foreground">{t("manage")}</p>
            </div>
            <TeamCreateDialog
              trigger={
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  {t("createTeam")}
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
            <p className="text-muted-foreground">{t("noTeams")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("noTeamsDesc")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {teams.map((team) => (
              <Link
                key={team.id}
                href={`/dashboard/teams/${team.id}/settings`}
                className="group block rounded-xl border bg-card/80 p-4 transition-colors hover:bg-accent"
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] md:items-center">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold">{team.name}</h3>
                    {team.isCrossTenant && (
                      <p className="truncate text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <Globe className="h-3 w-3 shrink-0" />
                        {team.tenantName}
                      </p>
                    )}
                    <p className="truncate text-sm text-muted-foreground">
                      {team.description || "—"}
                    </p>
                  </div>
                  <div className="min-w-0 text-sm text-muted-foreground">
                    <span className="mr-2 font-medium text-foreground">{t("slug")}:</span>
                    <span className="truncate font-mono">{team.slug}</span>
                  </div>
                  <div className="justify-self-start space-y-1 md:justify-self-center">
                    <TeamRoleBadge role={team.role} />
                    <p className="text-xs text-muted-foreground">{t("memberCount", { count: team.memberCount })}</p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarClock className="h-3 w-3" />
                    <span>{t("createdAtLabel", { date: formatDate(team.createdAt, locale) })}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
        </div>
    </div>
  );
}
