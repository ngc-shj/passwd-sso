"use client";

import { useEffect, useState, use } from "react";
import { useTranslations } from "next-intl";
import { TeamRoleBadge } from "@/components/team/management/team-role-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Trash2, Users, Search } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, API_PATH, apiPath } from "@/lib/constants";
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

export default function TeamMemberListPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const filteredMembers = filterMembers(members, memberSearch);

  useEffect(() => {
    fetchApi(API_PATH.AUTH_SESSION)
      .then((r) => r.json())
      .then((d) => setCurrentUserId(d?.user?.id ?? null))
      .catch(() => {});
  }, []);

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
  const isAdmin = team?.role === TEAM_ROLE.ADMIN || isOwner;

  const handleChangeRole = async (memberId: string, role: string) => {
    try {
      const res = await fetchApi(apiPath.teamMemberById(teamId, memberId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success(t("roleChanged"));
      fetchAll();
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      const res = await fetchApi(apiPath.teamMemberById(teamId, memberId), {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed");
      toast.success(t("memberRemoved"));
      fetchAll();
    } catch {
      toast.error(t("networkError"));
    }
  };

  if (!team) {
    if (loadError) {
      return (
        <Card>
          <CardContent>
            <div className="flex flex-col items-start gap-3">
              <h1 className="text-xl font-semibold">{t("forbidden")}</h1>
              <p className="text-sm text-muted-foreground">{t("noTeamsDesc")}</p>
              <Button variant="ghost" asChild>
                <Link href="/dashboard/teams">{t("manage")}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      );
    }
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <Card>
      <SectionCardHeader icon={Users} title={t("memberListTitle")} description={t("memberListDescription")} />
      <CardContent className="space-y-4">
        {members.length > 0 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchMembers")}
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        )}
        {members.length > 0 && filteredMembers.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("noMatchingMembers")}
          </p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {filteredMembers.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
              >
                <MemberInfo
                  name={m.name}
                  email={m.email}
                  image={m.image}
                  isCurrentUser={m.userId === currentUserId}
                  tenantName={m.tenantName}
                  teamTenantName={team.tenantName}
                />
                {isAdmin && m.role !== TEAM_ROLE.OWNER && m.userId !== currentUserId ? (
                  <div className="flex items-center gap-2">
                    <Select value={m.role} onValueChange={(v) => handleChangeRole(m.id, v)}>
                      <SelectTrigger className="w-28 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={TEAM_ROLE.ADMIN}>{t("roleAdmin")}</SelectItem>
                        <SelectItem value={TEAM_ROLE.MEMBER}>{t("roleMember")}</SelectItem>
                        <SelectItem value={TEAM_ROLE.VIEWER}>{t("roleViewer")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("removeMember")}</AlertDialogTitle>
                          <AlertDialogDescription>{t("removeMemberConfirm")}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("cancelInvitation")}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleRemoveMember(m.id)}>
                            {t("removeMember")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ) : (
                  <TeamRoleBadge role={m.role} />
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
