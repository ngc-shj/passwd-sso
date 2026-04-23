"use client";

import { useEffect, useState, useRef, useCallback, use } from "react";
import { useLocale, useTranslations } from "next-intl";
import { TeamRoleBadge } from "@/components/team/team-role-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MemberInfo } from "@/components/member-info";
import { CopyButton } from "@/components/passwords/copy-button";
import { Loader2, UserPlus, X, LinkIcon, Mail, Search } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { formatDate } from "@/lib/format/format-datetime";
import { fetchApi, appUrl } from "@/lib/url-helpers";

interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  tenantName?: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
  invitedBy: { name: string | null };
}

interface TenantMemberResult {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export default function TeamAddMemberPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  const locale = useLocale();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [inviting, setInviting] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addRole, setAddRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [adding, setAdding] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<TenantMemberResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = () => {
    fetchApi(apiPath.teamById(teamId))
      .then((r) => {
        if (!r.ok) throw new Error("Forbidden");
        return r.json();
      })
      .then((d) => setTeam(d))
      .catch(() => setTeam(null));

    fetchApi(apiPath.teamInvitations(teamId))
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) setInvitations(d);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchAll();
  }, [teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOwner = team?.role === TEAM_ROLE.OWNER;
  const isAdmin = team?.role === TEAM_ROLE.ADMIN || isOwner;

  const handleInvite = async () => {
    if (!invEmail.trim()) return;
    setInviting(true);
    try {
      const res = await fetchApi(apiPath.teamInvitations(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: invEmail.trim(), role: invRole }),
      });
      if (res.status === 409) {
        const data = await res.json();
        toast.error(
          data.error === "ALREADY_A_MEMBER"
            ? t("alreadyMember")
            : t("alreadyInvited")
        );
        setInviting(false);
        return;
      }
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const inviteUrl = appUrl(`/dashboard/teams/invite/${data.token}`);
      await navigator.clipboard.writeText(inviteUrl);
      toast.success(t("invitedWithLink"));
      setInvEmail("");
      fetchAll();
    } catch {
      toast.error(t("inviteFailed"));
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvitation = async (invId: string) => {
    try {
      await fetchApi(apiPath.teamInvitationById(teamId, invId), {
        method: "DELETE",
      });
      toast.success(t("invitationCancelled"));
      fetchAll();
    } catch {
      toast.error(t("networkError"));
    }
  };

  // Debounced tenant member search
  useEffect(() => {
    if (!addSearch.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetchApi(
        `${apiPath.teamMembersSearch(teamId)}?q=${encodeURIComponent(addSearch.trim())}`,
        { signal: controller.signal },
      )
        .then((r) => r.json())
        .then((d) => {
          if (!controller.signal.aborted) {
            setSearchResults(Array.isArray(d) ? d : []);
            setSearchLoading(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setSearchLoading(false);
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [addSearch, teamId]);

  const handleAddMember = useCallback(async (userId: string) => {
    setAdding(userId);
    try {
      const res = await fetchApi(apiPath.teamMembers(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: addRole }),
      });
      if (res.status === 409) {
        const data = await res.json();
        toast.error(
          data.error === "SCIM_MANAGED_MEMBER"
            ? t("scimManagedCannotAdd")
            : t("alreadyMember"),
        );
        setAdding(null);
        return;
      }
      if (!res.ok) throw new Error("Failed");
      toast.success(t("memberAdded"));
      setAddSearch("");
      setSearchResults([]);
      fetchAll();
    } catch {
      toast.error(t("addMemberFailed"));
    } finally {
      setAdding(null);
    }
  }, [teamId, addRole, t]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAdmin && team !== null) {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("forbidden")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <SectionCardHeader icon={UserPlus} title={t("addMemberTitle")} description={t("addMemberDescription")} />
      <CardContent className="space-y-6">
        {/* Add from organization */}
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t("addFromTenantLabel")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{t("addFromTenantDesc")}</p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex-1 space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("searchTenantMembers")}
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-2 md:w-32">
              <Select value={addRole} onValueChange={setAddRole}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TEAM_ROLE.ADMIN}>{t("roleAdmin")}</SelectItem>
                  <SelectItem value={TEAM_ROLE.MEMBER}>{t("roleMember")}</SelectItem>
                  <SelectItem value={TEAM_ROLE.VIEWER}>{t("roleViewer")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {addSearch.trim() && (
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {searchLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : searchResults.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t("noTenantMembersFound")}
                </p>
              ) : (
                searchResults.map((u) => (
                  <div
                    key={u.userId}
                    className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
                  >
                    <MemberInfo
                      name={u.name}
                      email={u.email}
                      image={u.image}
                    />
                    <Button
                      size="sm"
                      onClick={() => handleAddMember(u.userId)}
                      disabled={adding === u.userId}
                    >
                      {adding === u.userId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <UserPlus className="h-4 w-4 mr-1" />
                      )}
                      {t("addButton")}
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
        <Separator />
        {/* Invite by email */}
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t("inviteByEmailLabel")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{t("inviteByEmailDesc")}</p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex-1 space-y-2">
              <Label>{t("inviteEmail")}</Label>
              <Input
                type="email"
                value={invEmail}
                onChange={(e) => setInvEmail(e.target.value)}
                placeholder={t("inviteEmailPlaceholder")}
              />
            </div>
            <div className="space-y-2 md:w-32">
              <Label>{t("inviteRole")}</Label>
              <Select value={invRole} onValueChange={setInvRole}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TEAM_ROLE.ADMIN}>{t("roleAdmin")}</SelectItem>
                  <SelectItem value={TEAM_ROLE.MEMBER}>{t("roleMember")}</SelectItem>
                  <SelectItem value={TEAM_ROLE.VIEWER}>{t("roleViewer")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleInvite}
              disabled={inviting || !invEmail.trim()}
              className="md:self-end"
            >
              {inviting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Mail className="h-4 w-4 mr-2" />
              )}
              {t("inviteSend")}
            </Button>
          </div>
        </section>
        {invitations.length > 0 && (
          <>
            <Separator />
            {/* Pending invitations */}
            <section className="space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <LinkIcon className="h-4 w-4 text-muted-foreground" />
                {t("pendingInvitations")}
              </h3>
              <div className="space-y-2">
                {invitations.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{inv.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("expiresAt", { date: formatDate(inv.expiresAt, locale) })}
                      </p>
                    </div>
                    <TeamRoleBadge role={inv.role} />
                    <CopyButton
                      getValue={() =>
                        appUrl(`/dashboard/teams/invite/${inv.token}`)
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleCancelInvitation(inv.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
