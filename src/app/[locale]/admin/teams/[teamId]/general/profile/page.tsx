"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/passwords/shared/copy-button";
import { Link } from "@/i18n/navigation";
import { Loader2, User } from "lucide-react";
import { NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } from "@/lib/validations";
import { useTeamProfileForm } from "@/hooks/team/use-team-profile-form";
import { FormDirtyBadge } from "@/components/settings/account/form-dirty-badge";

export default function TeamGeneralProfilePage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  const tCommon = useTranslations("Common");
  const {
    team,
    loadError,
    isAdmin,
    name,
    setName,
    description,
    setDescription,
    saving,
    hasChanges,
    handleUpdateTeam,
  } = useTeamProfileForm(teamId);

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

  return (
    <Card>
      <SectionCardHeader
        icon={User}
        title={t("generalProfileTitle")}
        description={t("generalProfileDesc")}
      />
      <CardContent className="space-y-4">
        {isAdmin ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="team-name">{t("teamName")}</Label>
                <Input
                  id="team-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={NAME_MAX_LENGTH}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="team-slug">{t("slug")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="team-slug"
                    value={team.slug}
                    readOnly
                    className="bg-muted text-muted-foreground cursor-default"
                  />
                  <CopyButton getValue={() => team.slug} />
                </div>
                <p className="text-xs text-muted-foreground">{t("slugReadOnly")}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="team-description">{t("description")}</Label>
              <Textarea
                id="team-description"
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
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("forbidden")}</p>
        )}
      </CardContent>
    </Card>
  );
}
