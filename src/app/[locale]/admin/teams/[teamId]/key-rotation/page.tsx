"use client";

import { use, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { TeamRotateKeyButton } from "@/components/team/security/team-rotate-key-button";
import { TeamRekeyFinishControl } from "@/components/team/security/team-rekey-finish-control";
import { KeyRound } from "lucide-react";

export default function TeamKeyRotationPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  // Bumped by a committed rotation: the finish control then starts the pass.
  const [rekeyStartToken, setRekeyStartToken] = useState(0);

  return (
    <Card>
      <SectionCardHeader icon={KeyRound} title={t("rotateKeyTitle")} description={t("rotateKeyDesc")} />
      <CardContent className="space-y-6">
        <TeamRotateKeyButton teamId={teamId} onSuccess={() => setRekeyStartToken((n) => n + 1)} />
        <Separator />
        {/* Remounted after a committed rotation so it reloads and starts the pass. */}
        <TeamRekeyFinishControl key={rekeyStartToken} teamId={teamId} autoStart={rekeyStartToken > 0} />
      </CardContent>
    </Card>
  );
}
