"use client";

import { useEffect, useState, use } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Link } from "@/i18n/navigation";
import { AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";

interface TeamInfo {
  id: string;
  name: string;
  role: string;
}

export default function TeamGeneralDeletePage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  const router = useRouter();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  useEffect(() => {
    setTeam(null);
    setLoadError(false);
    fetchApi(apiPath.teamById(teamId))
      .then((r) => {
        if (!r.ok) throw new Error("Forbidden");
        return r.json();
      })
      .then((d) => setTeam({ id: d.id, name: d.name, role: d.role }))
      .catch(() => setLoadError(true));
  }, [teamId]);

  const isOwner = team?.role === TEAM_ROLE.OWNER;

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
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-start gap-3">
              <h2 className="text-xl font-semibold">{t("forbidden")}</h2>
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

  if (!isOwner) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <SectionCardHeader
        icon={Trash2}
        title={t("generalDeleteTitle")}
        description={t("generalDeleteDesc")}
      />
      <CardContent className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {t("generalDeleteWarningTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("generalDeleteWarningBody", { name: team.name })}
          </p>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li>{t("generalDeleteImpactVault")}</li>
            <li>{t("generalDeleteImpactMembers")}</li>
            <li>{t("generalDeleteImpactAuditLogs")}</li>
            <li>{t("generalDeleteImpactPolicies")}</li>
          </ul>
        </div>
        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            setDeleteDialogOpen(open);
            if (!open) setDeleteConfirmText("");
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              {t("deleteTeam")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteTeam")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteTeamConfirm", { name: team.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <Label htmlFor="delete-confirm-input">{t("deleteTeamTypeLabel")}</Label>
              <Input
                id="delete-confirm-input"
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
      </CardContent>
    </Card>
  );
}
