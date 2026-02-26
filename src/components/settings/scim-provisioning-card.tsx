"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScimTokenManager } from "@/components/team/team-scim-token-manager";
import { API_PATH, TEAM_ROLE } from "@/lib/constants";

type TeamSummary = {
  id: string;
  name: string;
  role: string;
};

export function ScimProvisioningCard() {
  const t = useTranslations("Team");
  const locale = useLocale();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      try {
        const res = await fetch(API_PATH.TEAMS);
        if (!res.ok) {
          toast.error(t("networkError"));
          return;
        }
        const data = (await res.json()) as TeamSummary[];
        if (!alive) return;
        setTeams(Array.isArray(data) ? data : []);
      } catch {
        toast.error(t("networkError"));
      } finally {
        if (alive) setLoading(false);
      }
    };

    run();
    return () => {
      alive = false;
    };
  }, [t]);

  const manageableTeams = useMemo(
    () => teams.filter((team) => team.role === TEAM_ROLE.OWNER || team.role === TEAM_ROLE.ADMIN),
    [teams]
  );

  useEffect(() => {
    if (!manageableTeams.length) {
      setSelectedTeamId(null);
      return;
    }
    if (!selectedTeamId || !manageableTeams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(manageableTeams[0].id);
    }
  }, [manageableTeams, selectedTeamId]);

  if (loading) {
    return (
      <Card className="rounded-xl border bg-card/80 p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading SCIM settings...
        </div>
      </Card>
    );
  }

  if (!manageableTeams.length || !selectedTeamId) {
    return null;
  }

  return (
    <div className="space-y-4">
      {manageableTeams.length > 1 && (
        <Card className="rounded-xl border bg-card/80 p-4">
          <section className="space-y-2">
            <Label>SCIM Managed Team</Label>
            <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {manageableTeams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>
        </Card>
      )}
      <ScimTokenManager teamId={selectedTeamId} locale={locale} />
    </div>
  );
}
