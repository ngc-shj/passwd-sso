"use client";

import { useEffect, useState, use } from "react";
import { useTranslations } from "next-intl";
import { TeamRoleBadge } from "@/components/team/team-role-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { MemberInfo } from "@/components/member-info";
import { Link } from "@/i18n/navigation";
import { Crown, Search } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { filterMembers } from "@/lib/filter-members";

interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  tenantName?: string;
}

interface Member {
  id: string;
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  image: string | null;
  joinedAt: string;
  tenantName: string | null;
}

export default function TeamTransferOwnershipPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [transferSearch, setTransferSearch] = useState("");
  const transferCandidates = filterMembers(
    members.filter((m) => m.role !== TEAM_ROLE.OWNER),
    transferSearch,
  );

  const fetchAll = () => {
    fetchApi(apiPath.teamById(teamId))
      .then((r) => {
        if (!r.ok) throw new Error("Forbidden");
        return r.json();
      })
      .then((d) => {
        setTeam(d);
        setLoadError(false);
      })
      .catch(() => {
        setTeam(null);
        setLoadError(true);
      });

    fetchApi(apiPath.teamMembers(teamId))
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) setMembers(d);
      })
      .catch(() => {});
  };

  useEffect(() => {
    setTeam(null);
    setLoadError(false);
    fetchAll();
  }, [teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOwner = team?.role === TEAM_ROLE.OWNER;

  const handleTransferOwnership = async (memberId: string) => {
    try {
      const res = await fetchApi(apiPath.teamMemberById(teamId, memberId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: TEAM_ROLE.OWNER }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success(t("ownershipTransferred"));
      fetchAll();
    } catch {
      toast.error(t("networkError"));
    }
  };

  if (!team) {
    if (loadError) {
      return (
        <Card className="rounded-xl border bg-card/80 p-6">
          <div className="flex flex-col items-start gap-3">
            <h1 className="text-xl font-semibold">{t("forbidden")}</h1>
            <p className="text-sm text-muted-foreground">{t("noTeamsDesc")}</p>
            <Button variant="ghost" asChild>
              <Link href="/dashboard/teams">{t("manage")}</Link>
            </Button>
          </div>
        </Card>
      );
    }
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isOwner) {
    return (
      <Card className="rounded-xl border bg-card/80 p-6">
        <p className="text-sm text-muted-foreground">{t("forbidden")}</p>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border bg-card/80 p-4">
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Crown className="h-4 w-4" />
          {t("transferOwnership")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("transferOwnershipDesc")}</p>
        {members.length > 1 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchMembers")}
              value={transferSearch}
              onChange={(e) => setTransferSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        )}
        {transferCandidates.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {transferSearch.trim()
              ? t("noMatchingMembers")
              : t("noTransferCandidates")}
          </p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {transferCandidates.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
              >
                <MemberInfo
                  name={m.name}
                  email={m.email}
                  image={m.image}
                >
                  <TeamRoleBadge role={m.role} />
                </MemberInfo>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Crown className="h-3.5 w-3.5 mr-1" />
                      {t("transferButton")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("transferOwnership")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("transferOwnershipConfirm", { name: m.name ?? m.email ?? "" })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancelInvitation")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleTransferOwnership(m.id)}>
                        {t("transferButton")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
      </section>
    </Card>
  );
}
