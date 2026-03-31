"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <CardTitle>{t("rotateKeyTitle")}</CardTitle>
        </div>
        <CardDescription>{t("rotateKeyDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <TeamRotateKeyButton teamId={teamId} />
      </CardContent>
    </Card>
  );
}
