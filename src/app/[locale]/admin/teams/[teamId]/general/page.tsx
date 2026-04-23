"use client";

import { useEffect, useState, useMemo, use } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { CopyButton } from "@/components/passwords/shared/copy-button";
import { Link } from "@/i18n/navigation";
import { Loader2, ShieldAlert, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";
import { NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } from "@/lib/validations";
import { SectionLayout } from "@/components/settings/account/section-layout";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/account/form-dirty-badge";

interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  tenantName?: string;
}

export default function TeamGeneralPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  const tAdmin = useTranslations("AdminConsole");
  const router = useRouter();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [initialGeneral, setInitialGeneral] = useState<Record<string, unknown> | null>(null);

  const tCommon = useTranslations("Common");
  const currentGeneral = useMemo(() => ({ name, description }), [name, description]);
  const hasChanges = useFormDirty(currentGeneral, initialGeneral);
  useBeforeUnloadGuard(hasChanges);

  const fetchTeam = () => {
    fetchApi(apiPath.teamById(teamId))
      .then((r) => {
        if (!r.ok) throw new Error("Forbidden");
        return r.json();
      })
      .then((d) => {
        const desc = d.description ?? "";
        setTeam(d);
        setName(d.name);
        setDescription(desc);
        setInitialGeneral({ name: d.name, description: desc });
        setLoadError(false);
      })
      .catch(() => {
        setTeam(null);
        setLoadError(true);
      });
  };

  useEffect(() => {
    setTeam(null);
    setLoadError(false);
    fetchTeam();
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
      setInitialGeneral({ ...currentGeneral });
      notifyTeamDataChanged();
      fetchTeam();
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
      router.push("/dashboard");
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

  if (!team) {
    if (loadError) {
      return (
        <SectionLayout
          icon={Settings2}
          title={tAdmin("teamSectionGeneral")}
          description={tAdmin("teamSectionGeneralDesc")}
        >
          <Card>
            <CardContent className="pt-6">
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
            </CardContent>
          </Card>
        </SectionLayout>
      );
    }
    return (
      <div className="flex items-center justify-center h-full">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <SectionLayout
      icon={Settings2}
      title={t("generalSettings")}
      description={t("tabGeneralDesc")}
    >
      <Card>
        <SectionCardHeader icon={Settings2} title={tAdmin("navGeneral")} description={t("tabGeneralDesc")} />
        <CardContent className="space-y-6">
          {isAdmin ? (
            <section className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t("teamName")}</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX_LENGTH} />
                </div>
                <div className="space-y-2">
                  <Label>{t("slug")}</Label>
                  <div className="flex items-center gap-2">
                    <Input value={team.slug} readOnly className="bg-muted text-muted-foreground cursor-default" />
                    <CopyButton getValue={() => team.slug} />
                  </div>
                  <p className="text-xs text-muted-foreground">{t("slugReadOnly")}</p>
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
              <div className="flex items-center justify-between pt-1">
                <FormDirtyBadge
                  hasChanges={hasChanges}
                  unsavedLabel={tCommon("statusUnsaved")}
                  savedLabel={tCommon("statusSaved")}
                />
                <Button onClick={handleUpdateTeam} disabled={saving || !name.trim() || !hasChanges}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t("updateTeam")}
                </Button>
              </div>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">{t("forbidden")}</p>
          )}

          {isOwner && (
            <>
              <Separator />
              <section className="space-y-4">
                <h3 className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <ShieldAlert className="h-4 w-4" />
                  {t("deleteTeam")}
                </h3>
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
            </>
          )}
        </CardContent>
      </Card>
    </SectionLayout>
  );
}
