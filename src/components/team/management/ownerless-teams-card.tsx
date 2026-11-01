"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";
import { API_PATH, apiPath } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { fetchApi } from "@/lib/url-helpers";
import { handleStepUpError } from "@/lib/http/handle-step-up-error";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";

interface OwnerlessTeam {
  id: string;
  name: string;
  slug: string;
  members: { userId: string; role: string; name: string | null; email: string | null }[];
}

/**
 * Teams of the tenant whose OWNER left the tenant, for a tenant admin to
 * assign a new one from the remaining active members. Renders nothing when
 * every team has an owner.
 */
export function OwnerlessTeamsCard() {
  const t = useTranslations("Team");
  const tCommon = useTranslations("Common");
  const [teams, setTeams] = useState<OwnerlessTeam[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  type ReauthRetry = { teamId: string; userId: string };
  const handleRetryRef = useRef<(arg: ReauthRetry) => Promise<void>>(async () => {});
  const inlineReauth = useInlineReauth<ReauthRetry>((arg) => handleRetryRef.current(arg));

  const fetchTeams = () => {
    void (async () => {
      try {
        const res = await fetchApi(API_PATH.TENANT_TEAMS_OWNERLESS);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.teams)) setTeams(data.teams);
      } catch {
        // best-effort — the card stays hidden
      }
    })();
  };

  const assignOwner = async (teamId: string, userId: string) => {
    setSubmitting(teamId);
    try {
      // @stepup id:tenant-team-owner-post
      const res = await fetchApi(apiPath.tenantTeamOwner(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        if (await handleStepUpError(res, inlineReauth.triggerOnStaleError, { teamId, userId })) return;
        // States the admin can act on: the team got an owner meanwhile, the
        // chosen member left, or a tenant ADMIN chose themselves.
        const { error } = await res.json().catch(() => ({ error: null }));
        const message =
          error === API_ERROR.CONFLICT ? t("ownerAssignConflict")
          : error === API_ERROR.MEMBER_NOT_FOUND ? t("ownerAssignMemberGone")
          : error === API_ERROR.FORBIDDEN ? t("ownerAssignSelfForbidden")
          : null;
        if (!message) throw new Error("Failed");
        toast.error(message);
        fetchTeams();
        return;
      }
      toast.success(t("ownerAssigned"));
      fetchTeams();
    } catch {
      toast.error(t("networkError"));
    } finally {
      setSubmitting(null);
    }
  };

  useEffect(() => {
    handleRetryRef.current = async (retry) => assignOwner(retry.teamId, retry.userId);
  });

  useEffect(() => {
    fetchTeams();
  }, []);

  if (teams.length === 0) return null;

  return (
    <Card>
      <SectionCardHeader
        icon={Crown}
        title={t("ownerlessTeamsTitle")}
        description={t("ownerlessTeamsDescription")}
      />
      <CardContent className="space-y-3">
        {teams.map((team) => (
          <div
            key={team.id}
            className="flex flex-col gap-3 rounded-xl border bg-card/80 p-4 md:flex-row md:items-center"
          >
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-semibold">{team.name}</h3>
              <p className="truncate text-sm text-muted-foreground font-mono">{team.slug}</p>
            </div>
            {team.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("ownerlessTeamNoMembers")}</p>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={selected[team.id] ?? ""}
                  onValueChange={(v) => setSelected((prev) => ({ ...prev, [team.id]: v }))}
                >
                  <SelectTrigger className="w-64 h-9">
                    <SelectValue placeholder={t("selectNewOwner")} />
                  </SelectTrigger>
                  <SelectContent>
                    {team.members.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.name ?? m.email ?? m.userId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" disabled={!selected[team.id] || submitting === team.id}>
                      {t("assignOwner")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("assignOwner")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("assignOwnerConfirm", { team: team.name })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => assignOwner(team.id, selected[team.id])}>
                        {t("assignOwner")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        ))}
      </CardContent>
      <RecentSessionRequiredDialog
        {...inlineReauth.recentSessionDialogProps}
        cancelLabel={tCommon("cancel")}
      />
      <PasskeyReauthDialog
        {...inlineReauth.reauthDialogProps}
        cancelLabel={tCommon("cancel")}
      />
    </Card>
  );
}
