"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { TeamRotateKeyButton } from "@/components/team/team-rotate-key-button";
import { KeyRound } from "lucide-react";

export default function TeamKeyRotationPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");

  return (
    <Card>
      <SectionCardHeader icon={KeyRound} title={t("rotateKeyTitle")} description={t("rotateKeyDesc")} />
      <CardContent>
        <TeamRotateKeyButton teamId={teamId} />
      </CardContent>
    </Card>
  );
}
