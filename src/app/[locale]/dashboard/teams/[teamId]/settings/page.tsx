"use client";

import { useEffect, useState, useRef, useCallback, use } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { TeamRoleBadge } from "@/components/team/team-role-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { CopyButton } from "@/components/passwords/copy-button";
import { TeamPolicySettings } from "@/components/team/team-policy-settings";
import { TeamWebhookCard } from "@/components/team/team-webhook-card";
import { TabDescription } from "@/components/settings/tab-description";
import { Separator } from "@/components/ui/separator";
import { Link } from "@/i18n/navigation";
import { Loader2, UserPlus, Trash2, X, LinkIcon, Crown, Settings2, Users, Mail, ShieldAlert, Globe, Search, Shield, Webhook } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, API_PATH, apiPath } from "@/lib/constants";
import { formatDate } from "@/lib/format-datetime";
import { fetchApi, appUrl } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";
import { filterMembers } from "@/lib/filter-members";
import { NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } from "@/lib/validations";

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

export default function TeamSettingsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  const tWebhook = useTranslations("TeamWebhook");
  const locale = useLocale();
  const router = useRouter();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Invite form
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [inviting, setInviting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const filteredMembers = filterMembers(members, memberSearch);

  // Add from tenant
  const [addSearch, setAddSearch] = useState("");
  const [addRole, setAddRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [adding, setAdding] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<TenantMemberResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
        setName(d.name);
        setDescription(d.description ?? "");
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

    fetchApi(apiPath.teamInvitations(teamId))
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) setInvitations(d);
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

  const handleUpdateTeam = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetchApi(apiPath.teamById(teamId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      if (res.status === 400) {
        toast.error(t("validationError"));
        setSaving(false);
        return;
      }
      if (!res.ok) throw new Error("Failed");
      toast.success(t("updated"));
      notifyTeamDataChanged();
      fetchAll();
    } catch {
      toast.error(t("updateFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTeam = async () => {
    try {
      const res = await fetchApi(apiPath.teamById(teamId), { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      toast.success(t("deleted"));
      notifyTeamDataChanged();
      router.push("/dashboard/teams");
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

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

  const handleTransferOwnership = async (memberId: string) => {
    try {
      const res = await fetchApi(apiPath.teamMemberById(teamId, memberId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: TEAM_ROLE.OWNER }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success(t("ownershipTransferred"));
      notifyTeamDataChanged();
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

  if (!team) {
    if (loadError) {
      return (
        <div className="flex-1 overflow-auto p-4 md:p-6">
          <div className="mx-auto max-w-4xl">
            <Card className="rounded-xl border bg-card/80 p-6">
              <div className="flex flex-col items-start gap-3">
                <h1 className="text-xl font-semibold">{t("forbidden")}</h1>
                <p className="text-sm text-muted-foreground">
                  {t("noTeamsDesc")}
                </p>
                <Button variant="ghost" asChild>
                  <Link href="/dashboard/teams">
                    {t("manage")}
                  </Link>
                </Button>
              </div>
            </Card>
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-full">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <Users className="h-6 w-6" />
            <div>
              <h1 className="truncate text-2xl font-bold">
                {t("teamSettings")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("teamSettingsDescription")}
              </p>
            </div>
          </div>
        </Card>

        <Tabs defaultValue={isAdmin ? "general" : "members"} className="space-y-4">
          <TabsList className={`grid w-full ${isAdmin ? "grid-cols-4" : "grid-cols-2"}`}>
            <TabsTrigger value="general"><Settings2 className="h-4 w-4 mr-2" />{t("generalSettings")}</TabsTrigger>
            <TabsTrigger value="members"><Users className="h-4 w-4 mr-2" />{t("members")}</TabsTrigger>
            {isAdmin && <TabsTrigger value="policy"><Shield className="h-4 w-4 mr-2" />{t("securityPolicy")}</TabsTrigger>}
            {isAdmin && <TabsTrigger value="webhook"><Webhook className="h-4 w-4 mr-2" />{tWebhook("title")}</TabsTrigger>}
          </TabsList>

          <TabsContent value="general" className="space-y-4 mt-0">
            <TabDescription>{t("tabGeneralDesc")}</TabDescription>
            {isAdmin ? (
              <Card className="rounded-xl border bg-card/80 p-4">
                <section className="space-y-4">
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Settings2 className="h-5 w-5 text-muted-foreground" />
                    {t("generalSettings")}
                  </h2>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{t("teamName")}</Label>
                      <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX_LENGTH} />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("slug")}</Label>
                      <div className="flex items-center gap-2">
                        <Input value={team.slug} readOnly />
                        <CopyButton getValue={() => team.slug} />
                      </div>
                      <p className="text-xs text-muted-foreground">{t("slugHelp")}</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("description")}</Label>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={DESCRIPTION_MAX_LENGTH}
                      rows={3}
                    />
                  </div>
                  <div className="flex justify-end pt-1">
                    <Button onClick={handleUpdateTeam} disabled={saving || !name.trim()}>
                      {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {t("updateTeam")}
                    </Button>
                  </div>
                </section>
              </Card>
            ) : (
              <Card className="rounded-xl border bg-card/80 p-4">
                <p className="text-sm text-muted-foreground">{t("forbidden")}</p>
              </Card>
            )}

            {isOwner && (
              <Card className="rounded-xl border border-destructive/30 p-4">
                <section className="space-y-4">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-destructive">
                    <ShieldAlert className="h-5 w-5" />
                    {t("deleteTeam")}
                  </h2>
                  <AlertDialog
                    open={deleteDialogOpen}
                    onOpenChange={(open) => {
                      setDeleteDialogOpen(open);
                      if (!open) setDeleteConfirmText("");
                    }}
                  >
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive">{t("deleteTeam")}</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("deleteTeam")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("deleteTeamConfirm", { name: team.name })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <div className="space-y-2">
                        <Label>{t("deleteTeamTypeLabel")}</Label>
                        <Input
                          value={deleteConfirmText}
                          onChange={(e) => setDeleteConfirmText(e.target.value)}
                          placeholder={t("deleteTeamTypePlaceholder", { name: team.name })}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("deleteTeamTypeHint", { name: team.name })}
                        </p>
                      </div>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancelInvitation")}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleDeleteTeam}
                          disabled={deleteConfirmText !== team.name}
                        >
                          {t("deleteTeam")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </section>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="members" className="space-y-4 mt-0">
            <TabDescription>{t("tabMembersDesc")}</TabDescription>
            <Tabs defaultValue="list" className="space-y-4">
              <TabsList className={`grid w-full ${isOwner ? "grid-cols-3" : isAdmin ? "grid-cols-2" : "grid-cols-1"}`}>
                <TabsTrigger value="list">
                  <Users className="h-4 w-4 mr-1.5" />
                  {t("members")}
                </TabsTrigger>
                {isAdmin && (
                  <TabsTrigger value="add">
                    <UserPlus className="h-4 w-4 mr-1.5" />
                    {t("addMember")}
                  </TabsTrigger>
                )}
                {isOwner && (
                  <TabsTrigger value="transfer">
                    <Crown className="h-4 w-4 mr-1.5" />
                    {t("transferOwnership")}
                  </TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="list" className="mt-0">
                <Card className="rounded-xl border bg-card/80 p-4">
                  <section className="space-y-4">
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
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={m.image ?? undefined} />
                            <AvatarFallback>
                              {(m.name ?? m.email ?? "?").charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {m.name ?? m.email}
                              {m.userId === currentUserId && (
                                <span className="text-muted-foreground ml-1">{t("you")}</span>
                              )}
                            </p>
                            {m.name && m.email && (
                              <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                            )}
                            {m.tenantName && team.tenantName && m.tenantName !== team.tenantName && (
                              <p className="text-xs text-amber-600 dark:text-amber-400 truncate flex items-center gap-1">
                                <Globe className="h-3 w-3 shrink-0" />
                                {m.tenantName}
                              </p>
                            )}
                          </div>
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
                  </section>
                </Card>
              </TabsContent>

              {isOwner && (
                <TabsContent value="transfer" className="mt-0">
                  <Card className="rounded-xl border bg-card/80 p-4">
                    <section className="space-y-4">
                      <p className="text-sm text-muted-foreground">{t("transferOwnershipDesc")}</p>
                      <div className="max-h-96 space-y-2 overflow-y-auto">
                        {members
                          .filter((m) => m.role !== TEAM_ROLE.OWNER)
                          .map((m) => (
                            <div
                              key={m.id}
                              className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
                            >
                              <Avatar className="h-8 w-8">
                                <AvatarImage src={m.image ?? undefined} />
                                <AvatarFallback>
                                  {(m.name ?? m.email ?? "?").charAt(0).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{m.name ?? m.email}</p>
                                <TeamRoleBadge role={m.role} />
                              </div>
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
                    </section>
                  </Card>
                </TabsContent>
              )}

              {isAdmin && (
                <TabsContent value="add" className="space-y-4 mt-0">
                  {/* Add from organization */}
                  <Card className="rounded-xl border bg-card/80 p-4">
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
                                <Avatar className="h-8 w-8">
                                  <AvatarImage src={u.image ?? undefined} />
                                  <AvatarFallback>
                                    {(u.name ?? u.email ?? "?").charAt(0).toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{u.name ?? u.email}</p>
                                  {u.name && u.email && (
                                    <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                                  )}
                                </div>
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
                  </Card>

                  {/* Invite by email */}
                  <Card className="rounded-xl border bg-card/80 p-4">
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
                  </Card>

                  {/* Pending invitations */}
                  {invitations.length > 0 && (
                    <Card className="rounded-xl border bg-card/80 p-4">
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
                    </Card>
                  )}
                </TabsContent>
              )}
            </Tabs>
          </TabsContent>

          {isAdmin && (
            <TabsContent value="policy" className="space-y-4 mt-0">
              <TabDescription>{t("tabPolicyDesc")}</TabDescription>
              <TeamPolicySettings teamId={teamId} />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="webhook" className="space-y-4 mt-0">
              <TabDescription>{t("tabWebhookDesc")}</TabDescription>
              <TeamWebhookCard teamId={teamId} locale={locale} />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
