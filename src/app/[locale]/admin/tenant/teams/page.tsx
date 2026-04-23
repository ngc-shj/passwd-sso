"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { TeamCreateDialog } from "@/components/team/management/team-create-dialog";
import { TeamRoleBadge } from "@/components/team/management/team-role-badge";
import { Plus, UsersRound, CalendarClock, Globe } from "lucide-react";
import { API_PATH } from "@/lib/constants";
import { formatDate } from "@/lib/format/format-datetime";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";
import { useTenantRole } from "@/hooks/use-tenant-role";
import { SectionLayout } from "@/components/settings/account/section-layout";

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

export default function AdminTenantTeamsPage() {
  const t = useTranslations("Team");
  const tAdmin = useTranslations("AdminConsole");
  const locale = useLocale();
  const { isAdmin } = useTenantRole();
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTeams = () => {
    setLoading(true);
    fetchApi(API_PATH.TEAMS)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setTeams(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleCreated = () => {
    fetchTeams();
    notifyTeamDataChanged();
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTeams();
  }, []);

  return (
    <SectionLayout
      icon={UsersRound}
      title={tAdmin("sectionTeams")}
      description={tAdmin("sectionTeamsDesc")}
    >
      <Card>
        <SectionCardHeader
          icon={UsersRound}
          title={tAdmin("navTeams")}
          description={t("teamsDescription")}
          action={
            isAdmin ? (
              <TeamCreateDialog
                trigger={
                  <Button size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    {t("createTeam")}
                  </Button>
                }
                onCreated={handleCreated}
              />
            ) : undefined
          }
        />
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : teams.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <UsersRound className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-muted-foreground">{t("noTeams")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("noTeamsDesc")}
              </p>
            </div>
          ) : (
            teams.map((team) => (
              <Link
                key={team.id}
                href={`/admin/teams/${team.id}/general`}
                className="block rounded-xl border bg-card/80 p-4 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
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
            ))
          )}
        </CardContent>
      </Card>
    </SectionLayout>
  );
}
